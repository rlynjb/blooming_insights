# Filesystem, streams, and resource lifecycle

*Resource ownership · Language-agnostic (with Node/Web-Streams specifics)*

## Zoom out — where this concept lives

Two very different resource kinds show up in this codebase: filesystem handles (small, mostly for dev-time state and module load) and HTTP streams (the main artefact — every route response). Both share a lifecycle question: *who owns the resource, and who closes it?*

```
Zoom out — resources by kind

┌─ Filesystem ─────────────────────────────────────────────────────┐
│                                                                    │
│  MODULE LOAD (once per Node process)                              │
│  · legacy prompt files (readFileSync at top of module)            │
│    lib/agents/monitoring-legacy.ts:13 etc.                        │
│                                                                    │
│  REQUEST-TIME reads (all sync, all small)                         │
│  · demo snapshots (production replay path)                        │
│    app/api/briefing/route.ts:89, /agent/route.ts:52               │
│  · dev-only caches (auth, investigations)                         │
│    lib/mcp/auth.ts:118 (dev), lib/state/investigations.ts:24 (dev)│
│                                                                    │
│  WRITES                                                            │
│  · dev-only caches (auth + investigations), writeFileSync         │
│  · production writes: NONE (serverless FS is effectively R/O)     │
└──────────────────────────────────────────────────────────────────┘

┌─ Streams (Web Streams API, not node:stream) ──────────────────────┐
│                                                                    │
│  SERVER: new ReadableStream<Uint8Array>({ start(controller) {…} })│
│    → controller.enqueue(bytes)      ← per NDJSON event             │
│    → controller.close()             ← in the finally block         │
│                                                                    │
│  CLIENT: response.body.getReader() → readNdjson kernel            │
│    → reader.read()                  ← in a while(true) loop       │
│    → reader.cancel()                ← on cancelOn=true             │
│    → reader.releaseLock()           ← in a finally block           │
└──────────────────────────────────────────────────────────────────┘
```

## Structure pass — one axis, two altitudes

Trace *"who closes this resource on cancellation?"* across the two resource kinds.

```
"Who closes the resource on cancel?" — one question, two answers

┌─ Filesystem (in this codebase) ────────────────────┐
│  → NO ONE — every fs call is sync (readFileSync,   │
│    writeFileSync), so there's no half-open handle  │
│    to close on cancel                              │
└──────────────────┬────────────────────────────────┘
                   ▼
┌─ Streams (the real resource lifecycle) ────────────┐
│  → the finally block on the server                 │
│    controller.close() ALWAYS runs                  │
│                                                      │
│  → the reader.releaseLock() finally on the client  │
│    even if handle() throws                         │
└────────────────────────────────────────────────────┘
```

The seam that matters: **synchronous atomic reads ↔ long-lived streams.** The codebase deliberately uses `readFileSync` for filesystem access — the read either completes or throws, no in-flight handle. The interesting lifecycle mechanism is entirely on the streaming side.

## How it works

### Move 1 — the mental model

You know how `fetch()` returns a `Response` with a `.body` that's a `ReadableStream`? Server-side, this codebase constructs the same thing — a `new ReadableStream` — and returns it as the response body. The `start(controller)` callback is where the server-side async work happens; `controller.enqueue(bytes)` writes to the stream, and `controller.close()` signals end-of-stream to the client.

```
The Web Stream lifecycle — same shape both sides

  SERVER                              CLIENT
  ──────                              ──────

  new ReadableStream({                fetch(url).then(res => {
    start(controller) {                 const reader = res.body.getReader()
      // async work here                 while(true) {
      controller.enqueue(bytes)          const {value, done} = await reader.read()
      controller.enqueue(bytes)          if (done) break
      controller.close()   ────────►    handle(decode(value))
    }                                   }
  })                                    reader.releaseLock()
                                      })
```

Web Streams' end-of-stream signal is `controller.close()`; the reader observes it as `{done: true}`. Any bytes still in the buffer when `close()` is called are drained before the reader sees `done`.

### Move 2 — the mechanisms

#### Filesystem: sync-only, dev-only writes

Every filesystem call in this codebase is synchronous. There is no `fs.promises`, no `stream.Readable.from(fs.createReadStream())`, no half-open file handles to leak. Reads either complete or throw — atomic.

```
Every fs call in the codebase, categorized

  MODULE-LOAD READS (once per process, on the cold-start path)
  ┌────────────────────────────────────────────────────────────┐
  │ lib/agents/monitoring-legacy.ts:13                          │
  │ lib/agents/diagnostic-legacy.ts:14                          │
  │ lib/agents/recommendation-legacy.ts:14                      │
  │ lib/agents/query-legacy.ts:13                               │
  │   → const PROMPT = readFileSync(join(cwd, 'prompt.md'))     │
  └────────────────────────────────────────────────────────────┘

  REQUEST-TIME READS (sync, small files)
  ┌────────────────────────────────────────────────────────────┐
  │ app/api/briefing/route.ts:89   (demo snapshot)              │
  │ app/api/agent/route.ts:52      (demo snapshot)              │
  │ lib/mcp/auth.ts:118            (dev-only auth cache)        │
  │ lib/state/investigations.ts:24 (dev-only inv cache)         │
  └────────────────────────────────────────────────────────────┘

  WRITES (dev-only; skipped in production)
  ┌────────────────────────────────────────────────────────────┐
  │ lib/mcp/auth.ts:138            (const PERSIST = dev-only)   │
  │ lib/state/investigations.ts:36 (const PERSIST = dev-only)   │
  └────────────────────────────────────────────────────────────┘
```

The dev-only guard pattern:

```ts
// lib/state/investigations.ts:7
const PERSIST = process.env.NODE_ENV === 'development';

// lib/state/investigations.ts:32-40
export function saveInvestigation(insightId: string, events: AgentEvent[]): void {
  mem.set(insightId, events);
  if (PERSIST) {                                     // ★ SKIP in production
    const all = readJson(CACHE_FILE);
    all[insightId] = events;
    try {
      writeFileSync(CACHE_FILE, JSON.stringify(all));
    } catch {
      /* best effort */
    }
  }
}
```

The `PERSIST` gate is load-bearing: Vercel's serverless filesystem is effectively read-only (any write dies with the instance). The dev-only path uses the filesystem for developer convenience (survives hot-reload). Production uses in-memory + cookies.

#### The stream lifecycle — the actual load-bearing mechanism

Every streaming route has the same shape. Look at `/api/briefing` at `app/api/briefing/route.ts:190-336`:

```ts
// annotated skeleton
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const send = (e: BriefingEvent) =>
      controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
    const t0 = performance.now();                     // start timing
    const phases: Array<{phase, durationMs}> = [];
    try {
      req.signal.throwIfAborted();                    // ★ ABORT CHECK at each phase
      // schema bootstrap
      // coverage gate
      // list tools
      // monitoring scan
      // emit insights
      send({ type: 'done' });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return;                                        // ★ CLIENT CANCELLED — no error event
      }
      console.error('[briefing] error:', redactSecrets(formatError(e)));
      send({ type: 'error', message: … });            // ★ error event on wire
    } finally {
      try {
        await disposeDataSource();                    // ★ RELEASE: DataSource teardown
      } catch (disposeErr) {
        console.error('[briefing] dispose error:', …); // ★ but never mask the route error
      }
      console.log(JSON.stringify({ route, phases, aborted }));  // observability
      controller.close();                              // ★ ALWAYS close the stream
    }
  },
});
return new Response(stream, { headers: NDJSON_HEADERS });
```

The load-bearing skeleton — what breaks if each part is removed:

  → Drop **the `try` block** and errors bubble uncaught out of the async start callback; the runtime error is a lot less useful than a `{type: 'error'}` event on the wire.
  → Drop **the AbortError early return** and a client-cancel produces an error event nobody reads (the connection's already closed on their end).
  → Drop **`controller.close()` in the finally** and the client-side reader hangs on `reader.read()` waiting for `done`.
  → Drop **the `disposeDataSource()` call** and the per-request DataSource's resources aren't torn down (currently a no-op for Bloomreach, but the seam is there for future adapters).
  → Drop **the `finally` altogether** and the `console.log(phases)` never fires; you can't tell how much of the 300s budget got burned before the failure.

The `finally` is where the resource lifecycle actually lives. Every ephemeral thing in the request path gets released here: the DataSource, the stream, the observability log.

#### The client-side reader lifecycle — mirror pattern

```
readNdjson — the client's mirror of the finally pattern

// lib/streaming/ndjson.ts:28-63
const reader = body.getReader();                    // ★ ACQUIRE
const decoder = new TextDecoder();
let buf = '';
try {
  while (true) {
    if (opts?.cancelOn?.()) {
      await reader.cancel();                        // ★ EARLY RELEASE
      return;
    }
    const { value, done } = await reader.read();
    if (done) break;                                // ★ NORMAL RELEASE
    buf += decoder.decode(value, { stream: true });
    // …split lines, parse, dispatch…
  }
  // flush trailing buffer
  const tail = buf.trim();
  if (tail) {
    try { onEvent(JSON.parse(tail) as E); }
    catch (err) { opts?.onMalformed?.(tail, err); }
  }
} finally {
  reader.releaseLock();                             // ★ ALWAYS release, even on throw
}
```

The `reader.releaseLock()` in `finally` matters because a `ReadableStream` allows only one active reader at a time. If a caller doesn't release, subsequent attempts to read the same stream throw *"ReadableStream is already locked to a reader."* The `try/finally` guarantees release even if the `handle(event)` callback throws.

The `cancelOn` poll before every `reader.read()` (line 33) lets an outer consumer cancel cooperatively. `useBriefingStream` sets `cancelledRef.current = true` on effect cleanup at `lib/hooks/useBriefingStream.ts:298`; the next iteration of the reader loop notices, cancels the reader, and returns.

Note the deliberate asymmetry vs `useInvestigation`: that hook does NOT use `cancelOn` at all (it doesn't pass one). The comment at `lib/hooks/useInvestigation.ts:33-37` explains: React 19 StrictMode's mount → unmount → re-mount pattern combined with a started-guard aborted the stream and left logs empty. So `useInvestigation` lets the fetch complete even after unmount — `setState after unmount is a safe no-op` — and only guards against double-fetch via the ref latch.

#### The demo replay: `sleep`-between-enqueues

```
Demo replay — using sleep to pace the stream

// app/api/briefing/route.ts:99-142 (extract)
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const emit = async (e: BriefingEvent) => {
      controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
      await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));   // ★ pace = 140ms
    };
    try {
      // …emit workspace, coverage, trace, insights…
      await emit({ type: 'done' });
    } finally {
      controller.close();                                          // ★ SAME finally pattern
    }
  },
});
```

The demo path doesn't need auth, doesn't call agents, doesn't hit MCP. It's a pure enqueue + sleep loop. But the same `finally { controller.close() }` pattern shows up — the resource lifecycle contract is uniform across the codebase.

### Move 3 — the principle

**Every resource acquisition needs a matching release, and `finally` is where releases live.** The codebase is disciplined about this at both ends of the stream: the server always calls `controller.close()` in `finally`, the client always calls `reader.releaseLock()` in `finally`. That discipline is what keeps a client cancellation clean — no orphaned streams, no leaked reader locks, no missing observability logs.

The corollary: whenever you write async code that opens a resource, ask what the release is and where it goes. If the answer isn't "in a finally block near where I acquired it," you're setting up a leak.

## Primary diagram — the full resource lifecycle

```
Resource lifecycle — server side ↔ client side

SERVER (route.ts)
┌────────────────────────────────────────────────────────────────┐
│  new ReadableStream({                                           │
│    async start(controller) {         ★ ACQUIRE stream           │
│      const send = e => controller.enqueue(...)                  │
│      try {                                                       │
│        req.signal.throwIfAborted()                              │
│        // schema bootstrap                                       │
│        // list tools                                             │
│        // run agents (each threading req.signal)                 │
│        send({type: 'done'})                                     │
│      } catch (e) {                                              │
│        if (AbortError) return                                    │
│        send({type: 'error'})                                    │
│      } finally {         ★ ALWAYS runs, even on abort           │
│        await disposeDataSource()   ★ RELEASE data source        │
│        console.log(phases)         ★ observability log          │
│        controller.close()          ★ RELEASE stream             │
│      }                                                           │
│    }                                                             │
│  })                                                              │
└────────────────────────────────────────────────────────────────┘
              │  bytes ────►
              ▼
CLIENT (lib/streaming/ndjson.ts)
┌────────────────────────────────────────────────────────────────┐
│  const reader = body.getReader()   ★ ACQUIRE reader            │
│  try {                                                          │
│    while (true) {                                               │
│      if (cancelOn?.()) {                                        │
│        await reader.cancel()       ★ EARLY release               │
│        return                                                    │
│      }                                                           │
│      const {value, done} = await reader.read()                  │
│      if (done) break               ★ normal end of stream       │
│      // decode + split + dispatch                               │
│    }                                                             │
│  } finally {                                                    │
│    reader.releaseLock()            ★ ALWAYS release             │
│  }                                                              │
└────────────────────────────────────────────────────────────────┘
```

## Elaborate — why Web Streams instead of `node:stream`

Web Streams are the platform-neutral streaming primitive: they work identically in the browser, in Node, in Deno, in Bun. Node's `node:stream` module is older, has its own semantics (pipes, `.pipe()`, `Readable.from`), and doesn't natively cross into the browser. For a codebase where the same NDJSON kernel needs to run on both sides (`lib/streaming/ndjson.ts` is shared), Web Streams are the obvious choice.

The Next.js App Router returns a `Response` whose body is a Web `ReadableStream`. That's the interface Vercel expects; using `node:stream` would require adapters at the response boundary and lose the client-side portability.

The tradeoff: Web Streams' backpressure semantics are less explicit than `node:stream`'s (`.pipe()` handles backpressure automatically). In practice, blooming insights doesn't push enough data per second to trigger backpressure — an agent event every ~1s is well below any stream's throughput limit. If the codebase later grew a high-throughput streaming path (millions of events per second, arbitrary file uploads), the choice would deserve revisiting.

## Interview defense

**Q: What happens to the server-side stream when a client closes their tab mid-briefing?**

Four steps:

  1. The TCP connection closes; Vercel's runtime aborts `req.signal`.
  2. The next `req.signal.throwIfAborted()` throws `DOMException: AbortError`. If the throw happens between phases, that's where it lands; if it happens deep inside `dataSource.callTool` (via the composed signal), the transport throws with the AbortError as cause.
  3. The `catch` block at `app/api/briefing/route.ts:294-296` detects `AbortError` and returns without emitting an error event (no consumer to read it).
  4. The `finally` block runs: `disposeDataSource()`, `console.log(phases)`, `controller.close()`. The observability log records exactly how much of the 300s budget was burned before the cancel.

The load-bearing part: even on abort, the finally runs. Without that, the phase log would be missing exactly the cases where you most want to know what happened.

**Q: Why is `reader.releaseLock()` in a `finally` block?**

Web `ReadableStream` allows only one active reader at a time. If `handle(event)` throws — say, a malformed JSON line that JSON.parse rejects and no `onMalformed` handler catches — the reader is still locked. Any subsequent attempt to consume the same stream throws *"ReadableStream is already locked to a reader."* Putting `releaseLock()` in `finally` guarantees the lock releases even on the error path. Anchor: `lib/streaming/ndjson.ts:61-63`.

**Q: How does the codebase avoid stale reads of the dev auth cache?**

It doesn't — deliberately. `lib/mcp/auth.ts:117-122` calls `readFileSync` on every `readAll()`. That's O(one small file read) per provider method call. In dev, hot-reload wipes in-memory maps between requests, so the file is the source of truth. In production, the ALS+cookie path bypasses the file entirely (`process.env.NODE_ENV === 'development'` guard at line 34).

The cost is a synchronous file read per method call in dev. Fine for developer machines; would be unacceptable in production (which is exactly why prod uses the cookie path).

## See also

  → `03-event-loop-and-async-io.md` — the reader loop and how `await reader.read()` interleaves with React renders.
  → `07-backpressure-bounded-work-and-cancellation.md` — how `req.signal` composes with `AbortSignal.timeout` to cancel in-flight work at every layer.
  → `study-networking` — the HTTP semantics beneath the stream (connection reuse, TLS, chunked transfer).

# Filesystem, streams, and resource lifecycle

**Industry name:** Web Streams API · `ReadableStream` controller · file descriptor lifecycle · **Type:** Language-agnostic (Web Streams) + Node-specific (fs)

## Zoom out, then zoom in

Two kinds of "resource" in this codebase: **streams** (HTTP response bodies, NDJSON readers) and **file descriptors** (the dev-only auth/investigation caches, the committed demo JSONs). Streams cross the client↔server boundary; file descriptors live entirely in band 2 and only in development.

```
  Zoom out — resource handles by band

  ┌─ band 1: client ────────────────────────────────────────┐
  │  ReadableStream from fetch().body                       │
  │   └─ getReader() → .read() loop → releaseLock()         │
  └────────────────────────┬────────────────────────────────┘
                           │  bytes flow this way
  ┌─ band 2: server ★ THIS FILE ★ ─────────────────────────┐
  │                                                          │
  │  outgoing: new ReadableStream({start(controller){...}})  │
  │             ↳ controller.enqueue / .close                │
  │                                                          │
  │  filesystem (dev only, Vercel FS is read-only in prod):  │
  │   ─ .auth-cache.json       (lib/mcp/auth.ts:117-118)    │
  │   ─ .investigation-cache.json (lib/state/investigations) │
  │   ─ lib/state/demo-*.json   (committed, read-only)       │
  │                                                          │
  │  no streamed file I/O — readFileSync / writeFileSync     │
  └─────────────────────────────────────────────────────────┘
  ┌─ band 3: providers ────────────────────────────────────┐
  │  Bloomreach loomi-MCP responses (streaming HTTP)        │
  │  Anthropic Messages API responses (streaming chunks)    │
  └─────────────────────────────────────────────────────────┘
```

Zoom in. The interesting mechanics are (a) how the server-side `ReadableStream` controller lifecycle pairs with `controller.close()` in `finally`, and (b) how the client-side `reader.releaseLock()` in `finally` keeps the stream usable even after a cancel.

## Structure pass

**Axis: ownership — who is responsible for cleaning this resource up?**

```
  Three altitudes, one question

  ┌─ outgoing ReadableStream (server) ──────────────────────┐
  │  owner: the start() callback                             │  → finally block
  │  must call controller.close() exactly once               │     closes it
  └─────────────────────┬───────────────────────────────────┘
                        │  bytes cross HTTP
  ┌─ ReadableStream (client) ──────────────────────────────┐
  │  owner: the consumer of fetch().body                    │  → finally block
  │  must releaseLock() the reader                          │     releases it
  └─────────────────────┬───────────────────────────────────┘
                        │  unrelated layer
  ┌─ filesystem handles (dev only) ────────────────────────┐
  │  owner: Node — readFileSync/writeFileSync close the fd  │  → no manual
  │  no streams, no fs.open                                 │     cleanup needed
  └─────────────────────────────────────────────────────────┘
```

**Seam: where ownership transfers.** The server's `controller` is owned by the handler's `start()` closure; the client's `reader` is owned by the consumer's `try/finally`. The seam in between is the HTTP stream itself — once bytes are flushed, ownership of each chunk effectively transfers from server to client.

## How it works

### Move 1 — the mental model

You know how `fetch()` returns a `Response` whose `.body` is a `ReadableStream`? On the *server* side, you build that ReadableStream yourself with `new ReadableStream({ start(controller) { ... } })`, push bytes with `controller.enqueue(...)`, and signal end with `controller.close()`. On the *client* side, you call `body.getReader()` to get a reader, loop on `.read()` until `done`, and release the lock when finished.

```
  Pattern — server pushes, client pulls, both have a "close" obligation

   server                                client
  ─────────                              ────────────
  new ReadableStream({                   await fetch(url)
    start(controller) {                  res.body.getReader()
      ┌──► enqueue chunk 1 ─────────────►  read() resolves with chunk 1
      │    enqueue chunk 2 ─────────────►  read() resolves with chunk 2
      │    ...                            ...
      │    enqueue chunk N ─────────────►  read() resolves with chunk N
      │    close()         ─────────────►  read() resolves with {done:true}
      │                                    ───────────────────────────────
      │  obligation: close in finally     obligation: releaseLock in finally
    }
  })
```

Both sides have an `try { ... } finally { closeOrRelease() }` structure. Forget either side and the resource leaks.

### Move 2 — the moving parts

#### Move 2.1 — the server-side `ReadableStream` controller

`app/api/agent/route.ts:184-342` is the canonical example. The handler builds a stream, returns it as the Response body, and the stream's `start()` callback runs the agent loop while pushing NDJSON-encoded events through the controller.

```ts
// app/api/agent/route.ts:184-342 (shape, annotated)
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const collected: AgentEvent[] = [];
    const send = (e: AgentEvent) => {
      collected.push(e);
      controller.enqueue(encoder.encode(encodeEvent(e)));   // ← push one chunk
    };
    // ... helpers ...
    try {
      req.signal.throwIfAborted();
      const schema = await bootstrap(req.signal);
      // ... many agent steps, each calling send(...) ...
      send({ type: 'done' });
      if (step == null) saveInvestigation(insightId!, collected);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return;                                              // ← skip, fall through to finally
      }
      console.error('[agent] error:', redactSecrets(formatError(e)));
      send({ type: 'error', message: ... });
    } finally {
      try { await disposeDataSource(); } catch { ... }
      console.log(JSON.stringify({ route, sessionId, ... }));
      controller.close();                                    // ← obligation: exactly once
    }
  },
});
return new Response(stream, { headers: NDJSON_HEADERS });
```

The `controller.close()` is in `finally` to guarantee it fires on success, on caught error, and on client-cancel (via the AbortError path that returns early). Calling it twice throws; calling it never leaves the consumer's `read()` pending forever — which on the client manifests as a "stream that never ends" and a memory hold.

The `collected: AgentEvent[]` array is local to `start()` — it captures every event for the per-instance investigation cache via `saveInvestigation(insightId!, collected)`. When the stream closes, all references to `collected` go out of scope and the array is GC'd (except for the one reference now held by the investigation cache `Map`).

#### Move 2.2 — the client-side reader lifecycle

`lib/streaming/ndjson.ts:17-64` owns the consumer side:

```ts
// lib/streaming/ndjson.ts (annotated)
export async function readNdjson<E>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: E) => void,
  opts?: { cancelOn?: () => boolean; ... },
): Promise<void> {
  const reader = body.getReader();          // ← acquire lock on body
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (opts?.cancelOn?.()) {
        await reader.cancel();              // ← explicit cancel from consumer
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // ... split, parse, dispatch ...
    }
    // flush trailing buffer ...
  } finally {
    reader.releaseLock();                   // ← obligation: release whether success/throw/cancel
  }
}
```

`reader.releaseLock()` in `finally` is the symmetric obligation to the server's `controller.close()`. Once released, the `body` ReadableStream goes back to being "lockable" — though in this codebase the body is never re-acquired (we consume once and discard).

If you forgot to release: subsequent attempts to `getReader()` on the same body would throw `TypeError: ReadableStream is already locked`. Not a memory leak per se; a usability bug for the next consumer that doesn't exist here.

#### Move 2.3 — the cancellation handshake

Three places can fire a cancel; one place observes each:

```
  Layers-and-hops — cancellation across the stream boundary

  ┌─ client ────────────────────────┐
  │  user closes tab                │
  │   → browser cancels req.body    │
  │   → server req.signal aborts    │
  └──────────────┬──────────────────┘
                 │  hop 1: signal across HTTP
  ┌─ server handler ────────────────┐
  │  req.signal.throwIfAborted()    │
  │   at coarse boundaries          │
  │  + each await ds.callTool()     │
  │   sees signal via composed sig  │
  │                                 │
  │  catches AbortError, returns    │
  │  finally: controller.close()    │
  └──────────────┬──────────────────┘
                 │  hop 2: stream end
  ┌─ client reader.read() ──────────┐
  │  resolves with {done:true} or   │
  │  rejects with TypeError if      │
  │  cancelled mid-flight           │
  │  finally: reader.releaseLock()  │
  └─────────────────────────────────┘
```

The React hook (`useInvestigation`) deliberately does NOT fire the cancel from the consumer side (`lib/hooks/useInvestigation.ts:32-37` comment). React StrictMode mounts-unmounts-remounts, and cancelling on the first unmount with a `startedRef` guard blocking the re-mount would abort the stream and leave the trace empty. So the consumer here just stops reading; the server keeps running until it finishes (or hits the 300s ceiling).

This is the only place a stream isn't bilaterally closed on consumer disconnect. Server-side, the `req.signal` from the *underlying TCP close* would still abort eventually — but only when the browser severs the connection (closed tab, network failure). The hook intentionally keeps the connection open through React's churn.

#### Move 2.4 — the file-descriptor side

Filesystem usage in the repo, exhaustively:

| call site | file | purpose | scope |
|---|---|---|---|
| `lib/mcp/auth.ts:118` | `.auth-cache.json` | dev OAuth cache | dev only (gitignored) |
| `lib/mcp/auth.ts:138` | `.auth-cache.json` | dev OAuth cache write | dev only |
| `lib/state/investigations.ts:15` | `.investigation-cache.json` | dev investigation cache | dev only (gitignored) |
| `lib/state/investigations.ts:36` | `.investigation-cache.json` | dev investigation cache write | dev only |
| `lib/state/investigations.ts:15` | `lib/state/demo-investigations.json` | committed demo snapshot | read-only, committed |
| `app/api/agent/route.ts:51` | `lib/state/demo-insights.json` | committed demo snapshot fallback | read-only, committed |
| `app/api/briefing/route.ts:89` | `lib/state/demo-insights.json` | demo replay | read-only, committed |

All `readFileSync` / `writeFileSync` — synchronous, blocking. **Why sync is OK here:** these files are tiny (a few KB at most) and only touched in dev or for the committed demo, never in the production hot path. The OAuth cache writes happen during a one-off auth flow; the investigation cache writes happen once per investigation in dev. Production reads `lib/state/demo-*.json` once at handler entry for the demo branch.

The Vercel filesystem is read-only at runtime except for `/tmp`. The codebase never tries to write to `process.cwd()` in production — gated by `const PERSIST = process.env.NODE_ENV === 'development'` at `lib/mcp/auth.ts:34` and `lib/state/investigations.ts:7`. The try/catch around `writeFileSync` is belt-and-braces: *"best-effort; if the FS is read-only we simply lose persistence"* (`lib/mcp/auth.ts:140`).

**No streamed file I/O.** No `fs.createReadStream`, no `fs.createWriteStream`. Every file is read or written as a single buffer.

#### Move 2.5 — what BREAKS at each handle

  → **Forget `controller.close()` in the server `finally`.** Client-side `reader.read()` hangs forever; the browser holds the connection open; the response is never marked complete. In serverless this also extends the function billing.
  → **Forget `reader.releaseLock()` in the client `finally`.** The body ReadableStream stays locked; if anything tried to consume it again it'd throw. In this codebase nothing does, so the symptom is silent — but the pattern is the right one.
  → **Write to the production filesystem.** `writeFileSync` throws `EROFS`. The try/catch swallows it (`lib/mcp/auth.ts:139-141`); the code falls through silently. **The gate by `PERSIST` is what prevents this from ever firing in production** — the catch is purely defensive.
  → **Call `controller.close()` twice.** Throws `TypeError: invalid state`. The current code calls it exactly once, in `finally`.

### Move 3 — the principle

Every resource handle in an async system has a `try { use } finally { release }` shape — `controller.close()`, `reader.releaseLock()`, `fs.closeSync(fd)`. The hard cases aren't writing the `finally`; they're knowing **which side owns the close** when a stream crosses a boundary. The server-side `start()` owns the controller; the client-side consumer owns the reader; the HTTP layer in between is the only thing both can see. Get the ownership right and the cleanup is mechanical.

## Primary diagram

```
  Resource handles in blooming insights — every owner, every cleanup

  ┌─ server: app/api/{briefing,agent}/route.ts ──────────────────────┐
  │                                                                   │
  │  new ReadableStream({                                             │
  │    async start(controller) {                                      │
  │      try {                                                        │
  │        // push N events via controller.enqueue(...)               │
  │      } catch (e) {                                                │
  │        if (e is AbortError) return;                               │
  │        send({type:'error', ...})                                  │
  │      } finally {                                                  │
  │        await disposeDataSource();   ← per-request DS cleanup      │
  │        controller.close();          ← stream cleanup              │
  │      }                                                            │
  │    }                                                              │
  │  })                                                               │
  │                                                                   │
  └────────────────────────┬─────────────────────────────────────────┘
                           │  bytes flow over HTTP
  ┌─ client: lib/streaming/ndjson.ts ────────────────────────────────┐
  │                                                                   │
  │  const reader = body.getReader();                                 │
  │  try {                                                            │
  │    while (true) {                                                 │
  │      if (cancelOn()) { await reader.cancel(); return; }           │
  │      const { value, done } = await reader.read();                 │
  │      if (done) break;                                             │
  │      // parse and dispatch                                        │
  │    }                                                              │
  │  } finally {                                                      │
  │    reader.releaseLock();           ← reader cleanup               │
  │  }                                                                │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘

  Filesystem (dev only, gated by NODE_ENV === 'development'):
    readFileSync / writeFileSync — fd opened and closed by Node, no
    manual handle management. .auth-cache.json, .investigation-cache.json,
    lib/state/demo-*.json.
```

## Elaborate

The Web Streams API (`ReadableStream`, `WritableStream`, `TransformStream`) is the same standard in browsers and modern Node — that's why the same `readNdjson` shape works on both sides. The older Node-specific streams (`stream.Readable`, `stream.Writable`) are still around but the codebase uses Web Streams everywhere because Next.js route handlers return a `Response` whose body is a Web Stream.

The "exactly-once close" obligation is the analogue of an unbalanced `fopen`/`fclose` in C, or a missing `try-with-resources` in Java. Modern languages (Python's `with`, Rust's `Drop`, C#'s `using`) make this declarative; JavaScript leaves it as a `try/finally` pattern you have to write yourself — which is why every stream-consuming function in this repo follows the same template.

Worth reading: the WHATWG Streams spec for the precise lock semantics; Node's `fs.promises` docs for the async file-I/O API the codebase would reach for if it ever needed non-blocking file reads; Jake Archibald's "The 2018 streams series" for the conceptual model.

## Interview defense

**Q: Walk me through what happens when a user closes the tab during a live briefing.**

```
  user closes tab
       ↓
  browser cancels the underlying TCP connection
       ↓
  Vercel marks req.signal as aborted
       ↓
  server handler's await sees AbortError on the next yield:
   ─ inside agent.scan(), runAgentLoop hits await ds.callTool({signal})
   ─ composeSignals OR's req.signal with AbortSignal.timeout(30_000)
   ─ aborted signal fires first
   ─ throws DOMException 'AbortError'
       ↓
  catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    ...
  }
       ↓
  finally {
    await disposeDataSource();   // no-op for Bloomreach
    controller.close();           // releases the response stream
  }
       ↓
  Vercel finalizes the function invocation
```

Anchor: "abort signal + finally block + early return on AbortError."

The exception is `useInvestigation` — it deliberately doesn't cancel its fetch on hook cleanup (`lib/hooks/useInvestigation.ts:32-37`), because React StrictMode's mount-cleanup-remount dance would otherwise leave the trace empty. So an *unmount* won't trigger the cancel chain above — only a real tab close / nav-away (where the browser severs the connection) will.

**Q: Why is the dev cache `writeFileSync` and not async?**

Two reasons. One, the file is tiny — kilobytes — so sync I/O is fast enough that the event-loop block is imperceptible. Two, the writes happen during dev-only auth flows and investigation completion, not in the hot path. Async would buy us nothing here.

In production the writes never fire — gated by `NODE_ENV === 'development'` at `lib/mcp/auth.ts:34` and `lib/state/investigations.ts:7`. Vercel's filesystem is read-only at runtime anyway, so even if we tried, the try/catch would swallow the EROFS.

```
  the rule:  sync I/O is fine when
             - the file is tiny (KB)
             - the call site is cold (dev / one-off)
             - the alternative (async) buys no real benefit
             otherwise, reach for fs.promises
```

## See also

  → `03-event-loop-and-async-io.md` for why `reader.read()` yields cleanly while file I/O blocks.
  → `07-backpressure-bounded-work-and-cancellation.md` for how `controller.close()` interacts with cancellation.
  → `study-system-design/05-streaming-ndjson.md` for the streaming protocol the controller pushes bytes for.

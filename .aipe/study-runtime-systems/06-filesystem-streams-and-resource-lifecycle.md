# Filesystem, Streams, and Resource Lifecycle

**Industry name:** resource lifecycle, Web Streams, ReadableStream · **Type:** Industry standard

## Zoom out — where this concept lives

This file walks two related concerns: (1) the filesystem use in this codebase, which is small and dev-only on the hot path, and (2) the `ReadableStream` lifecycle, which is the load-bearing primitive every live route emits through. Both are about resource ownership: who opens the resource, who closes it, what happens on abort.

```
  Zoom out — resources the runtime owns

  ┌─ Browser tab ────────────────────────────────────────────────────────┐
  │  ReadableStream reader (from fetch) — pulls bytes, can cancel        │
  │  sessionStorage / localStorage — storage, not a resource per se      │
  └────────────────┬─────────────────────────────────────────────────────┘
                   │
  ┌─ Node process ──▼────────────────────────────────────────────────────┐
  │                                                                      │
  │  ┌─ ReadableStream PRODUCER ────────────────────────────────────┐    │
  │  │  ★ THIS CONCEPT LIVES HERE ★                                 │    │
  │  │  every live route returns a ReadableStream with an           │    │
  │  │  async start(controller) — owns the work + the lifecycle     │    │
  │  └──────────────────────────────────────────────────────────────┘    │
  │                                                                      │
  │  ┌─ filesystem ─────────────────────────────────────────────────┐    │
  │  │  dev only: .auth-cache.json (auth.ts), .investigation-cache.json │
  │  │  prod: read-only filesystem; the dev caches degrade silently  │   │
  │  │  also: lib/state/demo-*.json (committed; read by replay path) │   │
  │  └──────────────────────────────────────────────────────────────┘    │
  └──────────────────────────────────────────────────────────────────────┘
```

The repo never opens a file descriptor in a long-lived way. All FS access is synchronous (`readFileSync`, `writeFileSync`, `existsSync`) on small JSON blobs. There are no `createReadStream` / `createWriteStream` calls, no file watches, no descriptor pools. That's a deliberate fit for serverless: Vercel's runtime filesystem is read-only outside `/tmp`, and there's no shared filesystem across instances anyway.

The interesting resource lifecycle is the WEB STREAMS one — every live route's `ReadableStream` controller is the actual resource that needs careful open/close discipline.

## Structure pass

### Axis: who owns the resource, and who must close it?

```
  Resource          Opener              Closer                    Risk if not closed
  ──────────────   ─────────────       ─────────────              ──────────────────
  ReadableStream   route handler       controller.close() in     reader hangs forever
  controller       (start callback)    finally block             waiting for more bytes

  fs file handle   readFileSync /      automatic (sync calls     n/a — sync ops can't
                   writeFileSync       don't return a handle)    leak handles

  ReadableStream   browser fetch       reader.cancel() or natural ndjson reader stuck
  reader           consumer             EOF                      in await reader.read()

  DataSource       per-request factory disposeDataSource() in    no-op today; future
  instance         (makeDataSource)    finally block             adapters need it
```

The route handlers OWN closing the producer controller, the browser hooks OWN cancelling the consumer reader, and the factory dispose chain is the seam for future adapters with real resources.

### Seams

The seam that matters is **the `finally` block in every route handler**. That's the single guaranteed code path on every exit (success, error, client abort) — which is exactly when teardown must happen. If a route handler can throw without hitting `finally`, the controller never closes and the reader hangs until the platform's `maxDuration` (300s) kills it.

## How it works

### Move 1 — the mental model

You know how a `try/finally` runs the finally block whether the try succeeds or throws? That's the same shape every live route handler in this codebase uses for stream teardown. The work happens in `try`, error reporting in `catch`, and EVERY exit path runs `finally` to: dispose the DataSource (a no-op today, real for future adapters), and close the controller so the browser's reader can finish. Skip the finally and the browser hangs.

```
  The producer-consumer lifecycle — one controller, one reader, two ends

  ┌─ Node: ReadableStream producer ──────────────────────────────────────┐
  │                                                                      │
  │   start(controller) {                                                │
  │     try {                                                            │
  │       // ... agent work ...                                          │
  │       controller.enqueue(bytes)                                      │
  │       // ... more work ...                                           │
  │       send({type: 'done'})                                           │
  │     } catch (e) {                                                    │
  │       send({type: 'error', message: ...})                            │
  │     } finally {                                                      │
  │       await disposeDataSource()                                      │
  │       controller.close()  ← MUST run on every exit path              │
  │     }                                                                │
  │   }                                                                  │
  │                                                                      │
  └────────────────┬─────────────────────────────────────────────────────┘
                   │  bytes flow via HTTP
                   ▼
  ┌─ Browser: ReadableStream consumer ───────────────────────────────────┐
  │                                                                      │
  │   const reader = body.getReader()                                    │
  │   try {                                                              │
  │     while (true) {                                                   │
  │       if (cancelOn()) { await reader.cancel(); return }              │
  │       const { value, done } = await reader.read()                    │
  │       if (done) break                                                │
  │       // ... parse + dispatch ...                                    │
  │     }                                                                │
  │   } finally {                                                        │
  │     reader.releaseLock()                                             │
  │   }                                                                  │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘
```

### Move 2 — the moving parts

#### The producer side: `ReadableStream` + `start(controller)`

Both live routes (`/api/agent` and `/api/briefing`) follow the same shape. Walk `briefing` because it's the simpler of the two:

```ts
// app/api/briefing/route.ts:191-329 (the load-bearing skeleton)
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const send = (e: BriefingEvent) =>
      controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
    // ...
    try {
      req.signal.throwIfAborted();           // ← bail fast if client already cancelled
      // ... bootstrap, coverage, agent scan, emit insights ...
      send({ type: 'done' });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return;                              // ← client cancel: skip error event, hit finally
      }
      console.error('[briefing] error:', redactSecrets(formatError(e)));
      send({ type: 'error', message: ... });
    } finally {
      try {
        await disposeDataSource();           // ← dispose hook for the per-request DataSource
      } catch (disposeErr) {
        console.error('[briefing] dispose error:', ...);
      }
      console.log(JSON.stringify({ /* phase summary */ }));
      controller.close();                    // ← MUST fire; reader hangs forever otherwise
    }
  },
});
return new Response(stream, { headers: { /* ... */ } });
```

Four discipline rules visible in this shape:

1. **Throw-if-aborted at coarse boundaries.** `req.signal.throwIfAborted()` is called before each expensive phase. If the client already cancelled, the throw lands in `catch`, the AbortError is recognized, the catch returns immediately, the `finally` still runs. No error event is emitted (no consumer to read it).
2. **Distinguish client cancel from real errors.** Inside `catch`, the `DOMException && name === 'AbortError'` check is the cancel-vs-failure split. Logging an "error" for a cancel would create false alerts in production.
3. **`finally` is the only guaranteed teardown.** Both `disposeDataSource` and `controller.close()` live there. Wrapping `disposeDataSource` in its own try/catch so a dispose failure doesn't swallow a route-level error.
4. **Phase summary log fires on every exit.** Inside `finally`, the `console.log({ phases, totalMs, aborted })` line emits regardless of success/failure/cancel. That's the only way to see how much of the 300s budget was burned before failure.

The agent route adds a complication — it ALSO produces a `ReadableStream` for cache replay (`app/api/agent/route.ts:127-141`), which checks `req.signal.aborted` between enqueues so a cancel mid-replay doesn't keep enqueuing into a closed reader. Same lifecycle discipline, smaller scope.

#### The consumer side: `readNdjson` pull-loop

```ts
// lib/streaming/ndjson.ts:17-64 — the canonical consumer
export async function readNdjson<E>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: E) => void,
  opts?: {
    cancelOn?: () => boolean;
    onMalformed?: (line: string, err: unknown) => void;
  },
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (opts?.cancelOn?.()) {
        await reader.cancel();
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        try {
          onEvent(JSON.parse(line) as E);
        } catch (err) {
          opts?.onMalformed?.(line, err);
        }
      }
    }
    // flush trailing buffer
    const tail = buf.trim();
    if (tail) {
      try { onEvent(JSON.parse(tail) as E); } catch (err) { opts?.onMalformed?.(tail, err); }
    }
  } finally {
    reader.releaseLock();
  }
}
```

The discipline here mirrors the producer:

- The reader is locked when `getReader()` is called and MUST be released. `try/finally` around the loop guarantees `releaseLock()` even on throw.
- `cancelOn()` is polled between every read. When a React effect's cleanup flips the cancel ref (`cancelledRef.current = true` in `useBriefingStream.ts:298`), the next iteration sees true, calls `reader.cancel()` (which propagates a signal upstream to the producer, though our producer doesn't currently react to it), and exits.
- Trailing-buffer flush at EOF handles producers that don't end with `\n`. The repo's producers always do (via `encodeEvent`), so this is defensive — but it makes the function safe to use against arbitrary NDJSON sources.
- Malformed lines are silent by default. Most network glitches show up as truncated lines that won't parse; logging every one of these would flood the console. The optional `onMalformed` is the escape hatch.

Three call sites use this consumer: `lib/hooks/useBriefingStream.ts:288`, `lib/hooks/useInvestigation.ts:194`, `components/chat/StreamingResponse.tsx:108`. All three pass an event-dispatching `onEvent` and only the first passes a `cancelOn` — the other two use different cancel disciplines (a closure-captured `cancelled` flag in StreamingResponse; deliberate no-cancel in useInvestigation).

#### The filesystem use: small, sync, dev-only on the hot path

```ts
// lib/mcp/auth.ts:34-36, 117-141 — dev cache via sync fs
const PERSIST = process.env.NODE_ENV === 'development';
const CACHE_FILE = join(process.cwd(), '.auth-cache.json');
// ...
function readAll(): Store {
  const ctx = requestStore.getStore();
  if (ctx) return ctx.store;                           // production: ALS cookie path
  if (!PERSIST) return Object.fromEntries(memStore);   // test: in-memory
  try {
    if (existsSync(CACHE_FILE)) return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch { /* corrupt — treat as empty */ }
  return {};
}

function writeAll(store: Store): void {
  // ... same shape: ALS first, mem second, file last (dev only)
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(store));
  } catch { /* read-only FS — silently lose persistence */ }
}
```

Three backends, selected by `NODE_ENV`. The file path exists because Next's dev server reloads modules on file change, which would wipe a module-level `Map` mid-OAuth-flow. The PKCE verifier + DCR client info saved during `connect` must survive until `callback` exchanges the code — the file gives it a process-independent home in dev.

Why sync FS instead of async (`fs.promises.readFile`)?

- The blobs are tiny (a few KB at most).
- The reads happen during the OAuth flow, which already takes a network round-trip; an extra sync I/O is invisible.
- Sync ops have no descriptor lifecycle to manage. `readFileSync` opens, reads, closes in one call; no leak vector.

Same shape in `lib/state/investigations.ts:11-41`. Same shape for demo snapshot reads in the routes.

The PROD path swallows write errors silently (`/* read-only FS — silently lose persistence */`). On Vercel, the filesystem outside `/tmp` is read-only; the dev cache write would `EACCES`. The catch lets the app degrade gracefully — the ALS+cookie path is the prod source of truth, and the file write is a no-op.

#### The DataSource dispose hook — wired but no-op

```ts
// lib/data-source/index.ts:91-99 (the Bloomreach branch)
return {
  ok: true,
  mode,
  dataSource: bloomreachDs,
  bootstrap: (signal?: AbortSignal) => bootstrapSchema(bloomreachDs, { signal }),
  // Bloomreach is session-scoped, not subprocess-scoped — the client lives
  // across requests via the cookie store, so the route's `finally` doesn't
  // tear it down.
  dispose: async () => {},
};
```

The route handlers call `await disposeDataSource()` in `finally`. The Bloomreach branch returns a no-op because the OAuth state lives in the cookie store and the `BloomreachDataSource` instance has no long-lived handles to release. The seam is in place for a future adapter that DOES need real cleanup — a SQL connection pool, an open WebSocket, an in-process file lock — to plug in without changing the route.

The pattern is "build the disposal hook even when the current adapter doesn't need it." Cheap to maintain; costly to add later if the route handler's `finally` block was never wired for it.

### Move 2 variant — the load-bearing skeleton

Every live route emits via a `ReadableStream`. The kernel is:

```
  The stream-lifecycle kernel — what breaks when each piece is missing

  1. start(controller) async function
     drop it → no work happens; the stream is empty

  2. try { ... } around all the work
     drop it → an error path leaves the controller open; reader hangs

  3. controller.enqueue(bytes) for each chunk
     drop it → no data reaches the browser

  4. catch (e) { send error event }
     drop it → silent failure on the wire; the consumer's switch sees nothing

  5. finally { controller.close() }
     drop it → reader.read() returns { done: false, value: undefined } forever
                until maxDuration (300s) kills the request

  6. (optional) try { dispose() } in finally
     drop it → resources held by the per-request DataSource leak
                (currently no-op for Bloomreach; will matter for future adapters)
```

The interview payoff is naming #5. Beginners write `start(controller) { /* emit stuff */ }` and forget that the controller needs an explicit close — the browser will sit on a stuck reader for the full route budget. The repo's discipline is to put `controller.close()` in `finally`, never anywhere else.

### Move 3 — the principle

Resource lifetimes in serverless are bounded by the request, not by the process. The `try/finally` shape is the only reliable way to wire teardown to every exit path — including client abort, which arrives via `req.signal` and reaches the handler as an `AbortError` thrown from somewhere deep in an await chain. Discipline yourself to put cleanup in `finally`, never in `then` callbacks or success-path code; the `finally` is the only line guaranteed to run.

## Primary diagram

```
  The full stream lifecycle — producer and consumer, paired

  ┌─ /api/briefing route handler (producer) ─────────────────────────────┐
  │                                                                      │
  │   new ReadableStream({ async start(controller) {                     │
  │     try {                                                            │
  │       req.signal.throwIfAborted()       ← bail fast on cancel        │
  │       const schema = await bootstrap()                               │
  │       const tools  = await dataSource.listTools()                    │
  │       const items  = await agent.scan(hooks)                         │
  │       items.forEach(send) ← send = controller.enqueue(...)           │
  │       send({type: 'done'})                                           │
  │     } catch (e) {                                                    │
  │       if (AbortError) return                                         │
  │       send({type: 'error', ...})                                     │
  │     } finally {                                                      │
  │       await disposeDataSource()    ← no-op for Bloomreach today      │
  │       console.log({phases, ...})   ← always emitted (incident log)   │
  │       controller.close()           ← THE load-bearing line           │
  │     }                                                                │
  │   } })                                                               │
  │                                                                      │
  └─────────────────────────────────┬────────────────────────────────────┘
                                    │  HTTPS body bytes
                                    ▼
  ┌─ browser: readNdjson (consumer) ─────────────────────────────────────┐
  │                                                                      │
  │   const reader = body.getReader()                                    │
  │   try {                                                              │
  │     while (true) {                                                   │
  │       if (cancelOn()) { await reader.cancel(); return }              │
  │       const { value, done } = await reader.read()                    │
  │       if (done) break                                                │
  │       // ... split on \n, JSON.parse each, dispatch via onEvent ... │
  │     }                                                                │
  │   } finally {                                                        │
  │     reader.releaseLock()           ← release lock on every exit      │
  │   }                                                                  │
  └──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

Web Streams (the `ReadableStream` / `WritableStream` interfaces) are the standard JS streaming primitive in both browser and Node — they replaced Node's older `Readable`/`Writable` for new code. The pull-based model means the consumer controls flow (no need for `pause/resume` like the old Node streams), which fits the NDJSON-over-fetch shape perfectly. The price is that backpressure is implicit: if the consumer pulls slowly, the producer's `enqueue` calls hold bytes in an internal buffer. For this app's volume (a few dozen events per route), there's no risk; for a high-throughput data stream, you'd implement `pull(controller)` instead of `start(controller)` and let `desiredSize` drive emission.

The filesystem story is "as little as possible." Vercel's runtime makes `/tmp` writable but ephemeral and `/` read-only; the repo never assumes either. Dev caches exist for developer ergonomics; prod uses cookies and in-memory only. The pattern is "FS is a dev affordance, not a substrate." That's correct for this app — adding any production FS dependency would force a migration to a real storage backend at first scale.

The "not yet exercised" parts of this topic:

- **Node streams (`createReadStream` / `pipe`).** Not used. Web Streams cover every case.
- **Transform streams.** No `pipeThrough(new TransformStream(...))`. Encoding/decoding lives in plain async functions (`encodeEvent`, `readNdjson`'s decoder).
- **File descriptor pools.** No long-lived FDs at all.
- **Filesystem watches.** No `fs.watch`. Hot reload is Next's job.
- **`/tmp` usage on Vercel.** Not used — the demo capture writes go to `lib/state/demo-*.json`, which only succeeds in dev.

## Interview defense

> Q: "Walk me through what happens when a client closes the tab mid-stream."

`req.signal` fires (AbortSignal from the platform's request). It's threaded into every async layer below the route handler — into bootstrap, listTools, the agent loops, every `dataSource.callTool`. Whichever of those is currently `await`ing throws an `AbortError`. The route's `catch` block sees it, recognizes the AbortError, returns without emitting an error event. `finally` runs: `disposeDataSource()` (no-op today), the phase summary log fires (so we can see how much budget was burned), and `controller.close()` releases any remaining state. The browser's reader saw the cancel happen on its own side, so it doesn't see the close as a network event.

> Q: "What's the load-bearing part most people forget about ReadableStream?"

`controller.close()` in `finally`. Without it, the browser's reader sits in `await reader.read()` forever — never sees `done: true`, never breaks the loop. It'll wait until the platform's `maxDuration` kills the request, which is 300 seconds in this app. People put `controller.close()` in the success path and miss that error paths leak the connection.

> Q: "Why sync FS instead of async?"

Three reasons. The blobs are tiny (a few KB). The reads happen on flows that already do network I/O, so an extra sync op is invisible. And sync FS calls don't return a descriptor — there's no handle to leak. For a long-lived process or large files, async with explicit close would matter; this app has neither.

## See also

- `03-event-loop-and-async-io.md` — how the await chain in `start(controller)` parks the work.
- `07-backpressure-bounded-work-and-cancellation.md` — how `req.signal` reaches the awaits that throw `AbortError`.
- `04-shared-state-races-and-synchronization.md` — the ALS path that the dev FS fallback exists to mirror in production.

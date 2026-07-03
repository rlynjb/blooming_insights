# Filesystem, streams, and resource lifecycle

**Industry:** file descriptors, streams, and resource lifecycle · Language-agnostic

## Zoom out — where this concept lives

The interesting I/O in `blooming_insights` is *streaming NDJSON* between the server and the browser, and *SSR-guarded* browser storage access. Filesystem is a smaller story: a dev-only cache file, a demo snapshot, an eval receipts directory. Every I/O handle has an owner and a cleanup path — even the ones that look "just there."

```
  Zoom out — where I/O lives

  ┌─ Browser ──────────────────────────────────────────┐
  │  localStorage / sessionStorage (synchronous)       │
  │  fetch() body → ReadableStream reader              │
  │  no direct FS access                               │
  └────────────────────────┬───────────────────────────┘
                           │  streaming NDJSON
  ┌─ Vercel serverless ───▼────────────────────────────┐
  │  ★ THIS CONCEPT ★                                   │
  │  ReadableStream response body · fetch to upstream  │
  │  dev-only .auth-cache.json · demo-insights.json    │
  │  eval receipts (long-lived process only)           │
  └────────────────────────┬───────────────────────────┘
                           │
  ┌─ Upstream ────────────▼────────────────────────────┐
  │  their sockets, their state                        │
  └────────────────────────────────────────────────────┘
```

The concept: **every resource (fd, socket, stream, storage key) has a lifetime that must be closed or released**. The default lifetime — do nothing — is fine on serverless because process death cleans up everything. In dev or in the eval harness, do-nothing leaks.

## Structure pass — layers, axis, seams

Pick one axis — **who closes this resource?** — and trace it.

```
  One axis (who closes it?) down the layers

  ┌─ your code ────────────────────────────────┐
  │  fetch() body                → CALLER      │
  │                                (must read  │
  │                                or cancel)  │
  │  readFileSync                → NO-OP       │
  │                                (auto-closed│
  │                                on return)  │
  │  writeFileSync               → NO-OP       │
  │                                (auto-closed│
  │                                on return)  │
  └────────────────────────────────────────────┘
      ↓
  ┌─ Node / browser runtime ───────────────────┐
  │  ReadableStream controller  → runtime      │
  │  closes when stream ends                    │
  │  underlying socket           → runtime      │
  │  releases with GC of client                 │
  └────────────────────────────────────────────┘
      ↓
  ┌─ OS / process ─────────────────────────────┐
  │  everything gets closed on process exit    │
  │  (Vercel kills the instance eventually)    │
  └────────────────────────────────────────────┘

  seam that matters: request-lifetime vs process-lifetime
```

**The load-bearing seam:** anything with a per-request lifetime needs an explicit close/dispose path. Anything with a process-lifetime relies on process death for cleanup, which is fine on serverless and *not fine* in the eval harness (long-running vitest process) if the resource were held module-level.

## How it works

### Move 1 — the mental model

You know how a `fetch()` in the browser returns a `Response` whose `.body` is a `ReadableStream`? If you don't read that body (or explicitly `body.cancel()`), the underlying socket stays open until GC eventually closes it. The stream is a *pipe* — one end has a producer, the other end has a consumer, and if the consumer never pulls, the producer eventually blocks or drops. That's every stream, in every runtime.

```
  Pattern — a stream's lifecycle

  ┌── construct ─────────────────────────────────────┐
  │  new ReadableStream({ start(controller) {…} })   │
  │  producer registers with the controller          │
  └────────────────┬─────────────────────────────────┘
                   │
                   ▼
  ┌── produce ───────────────────────────────────────┐
  │  controller.enqueue(chunk)                       │
  │  ...                                             │
  │  controller.enqueue(chunk)                       │
  └────────────────┬─────────────────────────────────┘
                   │
                   ▼
  ┌── close ─────────────────────────────────────────┐
  │  controller.close()                              │
  │  reader sees stream end                          │
  └──────────────────────────────────────────────────┘

  cancellation: reader can also call cancel() at any point,
  which propagates to producer as an "aborted" signal
```

Get the close wrong and one of two things happens: the reader hangs forever (producer never closed), or the writer throws (writing to an already-closed stream). Neither happens in `blooming_insights` because the design is disciplined about it.

### Move 2 — the pieces

#### The NDJSON server-side stream

`app/api/agent/route.ts:189-193` constructs a `ReadableStream` for the NDJSON response body:

```
  // app/api/agent/route.ts:189-195 — the streaming response body
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const collected: AgentEvent[] = [];
      const send = (e: AgentEvent) => {
        collected.push(e);
        controller.enqueue(encoder.encode(encodeEvent(e)));
      };
      // … agent loop calls send() … finally { controller.close() }
    },
  });
```

**Who closes it:** the `async start` function returns eventually (either normally or via a thrown error caught in a `try/finally`). When it returns, `controller.close()` is called in the `finally` block. That signals end-of-stream to the browser.

**What happens on client abort:** `req.signal.aborted` is checked at coarse phase boundaries inside the async agent chain (`app/api/agent/route.ts:135, :231, :242, :253, :279`). If the client closes the tab or navigates away, `req.signal` aborts, `throwIfAborted()` throws, and the `catch/finally` releases resources (DataSource dispose, upstream cancellation via the composed AbortSignal).

**What happens if the agent throws:** the error is caught, sent as an `{ type: 'error' }` NDJSON event, and the stream is closed cleanly. The browser sees "one error event, then EOF" instead of a hung stream.

#### The NDJSON client-side reader

`lib/hooks/useInvestigation.ts:205` calls `readNdjson<AgentEvent>(res.body, handle)`. Under the hood, `readNdjson` (in `lib/streaming/ndjson.ts`) reads bytes from the `ReadableStream`, splits on `\n`, calls the handler per line, and resolves when the stream ends.

**Who closes it:** the server closes when the agent finishes. The client's `readNdjson` awaits `reader.read()` in a loop until `done: true`. When the server closes the stream, the `done` flag flips and `readNdjson` resolves.

**Deliberate no-cleanup on unmount:** the comment at `lib/hooks/useInvestigation.ts:34-38` explains it — under React StrictMode dev, the effect mounts, cleans up, remounts. If we cancelled the stream on cleanup, the started-guard would block the remount, leaving the trace empty. The chosen tradeoff: don't cancel, let the in-flight run complete. `setState` after unmount is a safe no-op in React 19.

```
  Layers-and-hops — NDJSON stream lifecycle

  ┌─ browser tab ──────────────┐
  │  fetch(url)                │
  │     ↓                      │
  │  res.body → readNdjson()   │  ← consumer
  │     │  read chunks         │
  │     │  split on \n         │
  │     │  handle(event)       │
  │     ▼                      │
  │  reader.read() done → true │
  └──────────┬─────────────────┘
             │  socket closed by server
             ▲  chunks flow this way
             │
  ┌─ Vercel instance ──────────┐
  │  new ReadableStream({      │
  │    async start(controller) │  ← producer
  │      const send = (e) =>   │
  │        controller.enqueue()│
  │      … agent loop …        │
  │      controller.close()    │
  │  })                        │
  └────────────────────────────┘

  reader ends when producer closes.
  producer ends via normal path, exception path, or abort path.
```

#### The dev-only auth cache file

`lib/mcp/auth.ts:34-38` picks a backend based on env. In dev, that's a JSON file:

```
  // lib/mcp/auth.ts:117-142 — synchronous file I/O
  function readAll(): Store {
    const ctx = requestStore.getStore();
    if (ctx) return ctx.store;
    if (!PERSIST) return Object.fromEntries(memStore);
    try {
      if (existsSync(CACHE_FILE)) return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Store;
    } catch { /* corrupt/unreadable — treat as empty */ }
    return {};
  }

  function writeAll(store: Store): void {
    // …
    if (!PERSIST) { memStore… ; return; }
    try {
      writeFileSync(CACHE_FILE, JSON.stringify(store));
    } catch { /* best-effort */ }
  }
```

**Why sync in dev:** Next's dev server hot-reloads modules on file change, which would wipe an in-memory Map mid-OAuth-flow (the DCR client info + PKCE verifier saved during `connect` must survive until the `callback` exchanges the code). A file persists across reloads. The sync API is fine because dev serves one user at a time.

**Resource lifecycle:** `readFileSync` and `writeFileSync` open, read/write, and close the fd all in one call. There's no lingering handle to clean up. If the FS is read-only (some edge cases), the write silently fails — persistence is best-effort.

**Not the production path:** `PERSIST = process.env.NODE_ENV === 'development'`. In production the whole file path is skipped; the ALS-scoped cookie store handles everything.

#### The demo snapshot file

`app/api/agent/route.ts:52-53` reads the demo file (`lib/state/demo-insights.json`):

```
  if (existsSync(DEMO_FILE)) {
    const snap = JSON.parse(readFileSync(DEMO_FILE, 'utf8')) as { insights?: Insight[] };
```

**Resource:** one sync read per request that hits the demo fallback path. The file is tiny (a snapshot of ~10 insights); the sync-blocking cost is negligible.

**Why sync here:** it's a fallback path hit rarely, and the alternative (async `readFile`) doesn't buy anything meaningful. The design accepts the tiny blocking cost for simpler code.

#### Client-side storage: localStorage and sessionStorage

Both are synchronous, per-origin, per-runtime APIs. The interesting resource-lifecycle aspect: **you must not touch them during SSR**. Node has no `localStorage`, and a bare reference throws `ReferenceError`. Every helper in `lib/mcp/config.ts` guards:

```
  // lib/mcp/config.ts:106-117 — SSR-safe read
  export function readPersistedConfig(): McpConfigOverride | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(BI_MCP_CONFIG_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!isMcpConfigOverride(parsed)) return null;
      return normalizeConfig(parsed);
    } catch {
      return null;
    }
  }
```

Same shape in `writePersistedConfig` (`:122`) and `persistedConfigHeader` (`:143`). Pattern: **check before use, never assume the browser is present**.

**Why the try/catch:** localStorage can throw. Safari Private Mode used to throw on `setItem`. Some enterprise browsers block storage entirely. The try/catch turns any throw into a silent no-op — the persisted config just doesn't get read/written. The app falls back to env-driven config; nothing crashes.

**The other client-side pattern that matters here:** the `useInvestigation` hook checks `typeof window !== 'undefined'` before reading `localStorage.getItem('bi:mode')` (`lib/hooks/useInvestigation.ts:159`). Belt-and-braces — the file has `'use client'` at the top so it should never SSR, but the guard is there in case someone imports something from it into a server component.

#### The MCP SDK Client's underlying transport

The MCP SDK holds an HTTP connection to the Bloomreach server. That connection is *not* one-request-and-close — the SDK pools connections for efficiency (Node's `undici` pools by default). We don't manage that lifecycle directly; the SDK does. `dsResult.dispose` (`app/api/agent/route.ts:186`) is the cleanup handle called in the route's `finally` — it releases the SDK's Client, which releases the transport, which returns the socket to the pool.

**Failure mode this hedges against:** a route that returns without calling `dispose` would leave one connection dangling per request. Over a warm instance's lifetime that would eventually exhaust the pool. Called in the `finally` block, `dispose` runs on both normal completion and error paths.

#### The eval receipts directory

`eval/load.eval.ts:135, :147` writes receipts to `eval/load-receipts/*.json`:

```
  mkdirSync(RECEIPTS_DIR, { recursive: true });
  // …
  writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
```

**Resource:** one file per run. Sync writes because the eval harness has no wall-clock budget and blocking on a tiny JSON write is fine. The directory grows over time; nothing prunes it (the equivalent of `receipts/` for the model eval also grows).

**Not a leak in the runtime-systems sense:** disk space, not memory. But it's the same discipline: name where the file lives, and know that nothing reclaims it automatically.

### Move 3 — the principle

Every open handle — a socket, a stream, a file descriptor, even a `localStorage` key — has a lifetime. The runtime helps by closing things at process death, but between "open" and "process death" you're on the hook. Serverless makes this look easy (short lifetimes, generous cleanup); dev servers and long-running processes make the same code look leaky. The discipline is: **construct in the try, release in the finally, and never assume the process will die soon**.

## Primary diagram

```
  Filesystem, streams, and resource lifecycle — full picture

  ┌─ Browser ────────────────────────────────────────────────────┐
  │                                                              │
  │  fetch(url).body                                             │
  │      │                                                       │
  │      ▼                                                       │
  │  readNdjson(body, handle)   ← reads until server closes      │
  │      │                                                       │
  │      ▼                                                       │
  │  handle(event) — one call per NDJSON line                   │
  │                                                              │
  │  storage APIs (guarded):                                    │
  │    if (typeof localStorage !== 'undefined') { … }           │
  │    try { localStorage.setItem(…) } catch { silent }         │
  │                                                              │
  │  no direct FS access                                        │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Vercel serverless (Node 20) ────────────────────────────────┐
  │                                                              │
  │  new ReadableStream({                                        │
  │    async start(controller) {                                 │
  │      try {                                                   │
  │        // agent loop calls send(event) → controller.enqueue  │
  │      } catch (e) {                                           │
  │        send({ type: 'error', message: e.message })           │
  │      } finally {                                             │
  │        controller.close()  ← always closes                   │
  │        recordPhase('done', t0)                               │
  │        await disposeDataSource()  ← release MCP transport    │
  │      }                                                       │
  │    }                                                         │
  │  })                                                          │
  │                                                              │
  │  dev-only file I/O (sync, best-effort):                     │
  │    readFileSync(CACHE_FILE, 'utf8')  ← auth cache            │
  │    writeFileSync(CACHE_FILE, …)      ← auth cache            │
  │    readFileSync(DEMO_FILE, 'utf8')   ← demo snapshot         │
  │                                                              │
  │  MCP SDK transport pool (managed by SDK):                   │
  │    connectMcp() returns a Client                            │
  │    dispose() releases the Client                            │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘

  ┌─ vitest process (eval only) ─────────────────────────────────┐
  │  mkdirSync(RECEIPTS_DIR, { recursive: true })                │
  │  writeFileSync(outPath, JSON.stringify(receipt))             │
  │  grows over time — not pruned                                │
  └──────────────────────────────────────────────────────────────┘

  discipline:
    · every producer closes its stream (finally block)
    · every consumer reads until done OR cancels explicitly
    · every SSR-unsafe API is guarded (typeof X === 'undefined')
    · every dispose() is called in a finally, not a happy path
```

## Elaborate

The `ReadableStream` API (from the WHATWG Streams spec) is browser-first; Node adopted it in v18. It replaces the older Node-style `Readable` (`.on('data')`, `.on('end')`) with a promise-native reader. The migration is more than cosmetic: WHATWG streams support automatic backpressure (the producer's `enqueue` waits when the consumer is slow) and standardized cancellation via the reader. Older Node streams needed manual pause/resume.

In this codebase, backpressure is theoretical — the NDJSON events are small (a hundred bytes each) and the consumer (the browser) reads them fast enough. But the API's shape (`controller.enqueue` returns a promise you can await if pressure matters) is there when it's needed.

The other important idea in this file — SSR guards — comes out of the Next.js reality. Server components run on Node; client components run in the browser. A module imported by both needs to be defensive about which APIs it touches at what time. `typeof localStorage === 'undefined'` is the standard shibboleth. Some codebases skip it (rely on `'use client'` markers), but the defense-in-depth pays off the day someone accidentally imports the config module into a server component.

Read `07-backpressure-bounded-work-and-cancellation.md` next — it walks how AbortSignal composes through the stream lifecycle. Then `08-runtime-systems-red-flags-audit.md` ranks the runtime risks with evidence.

## Interview defense

**Q: How does the NDJSON stream get cleaned up if the user closes their tab mid-investigation?**

The tab close aborts the browser's `fetch` — which propagates through the HTTP connection to the server — which fires `req.signal`. The route handler checks `req.signal.aborted` at coarse phase boundaries and calls `throwIfAborted()` before starting the next phase. That throws inside the async `start` function of the ReadableStream, which lands in the `catch/finally`. The `finally` calls `controller.close()` and `disposeDataSource()` — releasing the upstream MCP transport back to the pool. On the way out, the composed AbortSignal in `transport.ts` fires, so any in-flight MCP call also aborts within 30s (or immediately if it was waiting on the socket).

*Diagram to sketch: two boxes — browser and server — with an X on the browser side, an arrow across labeled "TCP RST → req.signal abort," then a chain of arrows on the server side: throwIfAborted → catch → finally → controller.close + dispose.*

**Q: Why is `readFileSync` used in `lib/mcp/auth.ts`? Doesn't that block the event loop?**

It does, but only in dev, and only on OAuth-flow requests (which are rare during dev). The reason: Next's dev server hot-reloads modules when files change, which would wipe an in-memory Map mid-OAuth flow — the client info and PKCE verifier saved during `connect` must survive until `callback` exchanges the code, and those two calls span a hot-reload if you touch any file in between. A file persists across reloads. In production, `NODE_ENV === 'development'` is false, so this whole path is skipped; the ALS-scoped cookie store handles everything and there's no sync I/O.

*Diagram to sketch: a switch labeled NODE_ENV — dev branch goes to `readFileSync` box, production branch goes to `AsyncLocalStorage.getStore()` box, with a comment "one path is blocking-but-fine, the other is async-and-required-for-scale."*

**Q: The load-bearing part people forget about client-side storage?**

That it can throw. Everyone remembers "guard for SSR" (`typeof localStorage === 'undefined'`), but skips the try/catch inside. Safari Private Mode used to throw on `setItem`. Some enterprise browsers block storage entirely. `lib/mcp/config.ts` wraps every access in a try/catch that turns the throw into a silent no-op. The app falls back to env-driven defaults; nothing crashes. Skip the try/catch and the modal will fail to save for a subset of users you can't easily identify.

*Diagram to sketch: a decision tree — `typeof localStorage undefined?` → yes → return null; no → try setItem → catches: quota exceeded, private mode, blocked — all fall to silent no-op.*

## See also

- `03-event-loop-and-async-io.md` — the async I/O primitives the streams build on
- `04-shared-state-races-and-synchronization.md` — the cross-instance state that survives via the encrypted cookie
- `07-backpressure-bounded-work-and-cancellation.md` — how AbortSignal composes through stream lifecycles

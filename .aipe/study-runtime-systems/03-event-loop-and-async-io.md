# Event loop and async I/O

**Industry name:** libuv event loop · V8 microtask queue · `AsyncLocalStorage` context propagation · **Type:** Language-specific (Node.js)

## Zoom out, then zoom in

You've seen the runtime map. Now zoom into the engine that actually decides what runs next on band 2. The event loop is what threads two concurrent requests through one thread without colliding their auth state — and the two pieces of this codebase that hang off it are **`AsyncLocalStorage`** and **the spacing-gate microtask**.

```
  Zoom out — the event loop's place

  ┌─ band 2: Node process ──────────────────────────────────────┐
  │                                                              │
  │  Next.js handler  ──┐                                        │
  │  Next.js handler  ──┤                                        │
  │  setTimeout cbs   ──┼──►  ★ EVENT LOOP ★  ──► whichever      │
  │  fetch resolves   ──┤                          callback      │
  │  AbortSignal fired──┘                          drains next   │
  │                                                              │
  │  ALS propagates the per-request context across each await    │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in — there are two stories this file tells:

  1. How `AsyncLocalStorage` (`lib/mcp/auth.ts:47`) survives every `await` in a handler so the per-request auth context never bleeds into another request.
  2. How the `await new Promise(r => setTimeout(r, …))` in the spacing gate (`lib/data-source/bloomreach-data-source.ts:193`) cooperates with the event loop instead of blocking it.

## Structure pass

**Axis: where does control go between two lines of my code?**

```
  Three altitudes, one question

  ┌─ sync code ────────────────────────────────────────────────┐
  │  line 1 → line 2 → line 3                                  │  → caller decides
  │  (no yield possible — nothing else can run)                │     (the runtime
  │                                                            │      can't preempt)
  └────────────────────┬───────────────────────────────────────┘
                       │  await happens
  ┌─ microtask boundary ▼─────────────────────────────────────┐
  │  Promise.then continuation is queued                       │  → V8 microtask
  │  (drains before next timer/I/O)                            │     queue decides
  └────────────────────┬───────────────────────────────────────┘
                       │  longer wait (setTimeout / fetch / signal)
  ┌─ libuv phases ─────▼──────────────────────────────────────┐
  │  timers / I/O callbacks / close callbacks                  │  → libuv decides
  │  (multiple per "tick" of the event loop)                   │     (FIFO per phase)
  └────────────────────────────────────────────────────────────┘
```

**Seam: every `await`.** Before it, your code owns the thread. After it, the event loop owns it. ALS exists precisely because the function continuation after an `await` is a *separate stack frame* — without ALS, anything that wants to know "which request am I in?" would have to thread that ID through every call argument.

That's the load-bearing insight. The mechanics below hang on it.

## How it works

### Move 1 — the mental model

You know how a `then(...)` callback runs *after* the Promise settles? Same shape, scaled up: every `await` is sugar over `then`, and the function suspends at that point. When the Promise resolves, the runtime queues your continuation in the **microtask queue**. The event loop drains that queue at the next safe point.

```
  Pattern — the await/microtask sandwich

  ┌─ handler stack frame ──────────────────────────────────────┐
  │  ... synchronous code ...                                  │
  │  ── line N: await dataSource.callTool(...)  ──►            │
  │                          │ Promise pending                  │
  │                          │                                  │
  │                          ▼                                  │
  │                 [event loop runs OTHER things]              │
  │                          │                                  │
  │                          │ Promise resolves                 │
  │                          ▼                                  │
  │                 [microtask queue: this continuation]        │
  │                          │                                  │
  │                          ▼                                  │
  │  ── line N+1: const result = ... resumes here ──            │
  │  ... synchronous code ...                                  │
  └────────────────────────────────────────────────────────────┘
```

The "OTHER things" between the two lines is the entire universe of concurrent requests, timers, and I/O on this instance. Your two adjacent lines of code — across an `await` — are not adjacent in wall time.

### Move 2 — the moving parts

#### Move 2.1 — the microtask queue vs the timer queue

`Promise.then` continuations go in the **microtask queue**, which drains in full before the event loop moves to the next phase. `setTimeout` callbacks go in the **timer queue**, which only fires when libuv reaches the timers phase.

This matters in the spacing-gate code:

```ts
// lib/data-source/bloomreach-data-source.ts:191-194
const elapsed = Date.now() - this.lastCallAt;
if (elapsed < this.minIntervalMs) {
  await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
}
```

The `await new Promise(r => setTimeout(r, …))` does two things:
  1. Schedules `setTimeout` for `minIntervalMs - elapsed` ms (timer queue).
  2. Suspends the current async frame, putting its continuation behind the Promise's `then`.

While we wait, libuv runs other I/O callbacks. When the timer fires, the Promise resolves, and the microtask queue puts our continuation back on the thread. We resume with the rate-limit budget reset.

```
  Execution trace — spacing gate yielding

  state:   lastCallAt = 1000ms, elapsed = 300ms, gap = 800ms
  ──────   ──────────────────────────────────────────────────
  t=1300   liveCall enters, computes 800ms wait
  t=1300   setTimeout(r, 800) scheduled
  t=1300   await yields → event loop free
  t=1300   ... handler B runs sync code, yields on its own fetch
  t=1300   ... NDJSON chunk for stream X arrives, enqueued
  t=1450   ... another handler's continuation drains
  t=2100   libuv timers phase: our setTimeout fires → r()
  t=2100   microtask drain: our continuation runs
  t=2100   transport.callTool(...) goes out, lastCallAt = 2100
```

The crucial detail: `setTimeout` for 800ms means "**at least** 800ms" — not exactly. If the event loop is busy at t=2100, the timer drains later. This is fine for rate-limiting (we want at-least spacing). It would not be fine for "fire at exactly t=2100" use cases — there are none of those in this repo.

#### Move 2.2 — `AsyncLocalStorage`: how context survives an await

`AsyncLocalStorage` (Node 14+) lets you set a value once at the top of an async chain and retrieve it from any descendant — including after arbitrary `await`s. Without it, you'd have to thread the value through every function argument.

In `lib/mcp/auth.ts`, the per-request store is created on entry to `withAuthCookies`:

```ts
// lib/mcp/auth.ts:46-47
interface RequestStore { store: Store; dirty: boolean }
const requestStore = new AsyncLocalStorage<RequestStore>();

// lib/mcp/auth.ts:86-104  (annotated)
export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
  const result = await requestStore.run(ctx, fn);              // ← establish ALS frame
  if (ctx.dirty) {                                              // ← read it back after fn done
    (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {
      httpOnly: true, secure: true, sameSite: 'none', path: '/',
      maxAge: AUTH_COOKIE_MAX_AGE,
    });
  }
  return result;
}
```

Inside `fn`, anywhere that does `requestStore.getStore()` sees the *same* `ctx` object — even across many `await`s, across deep tool-call chains, across the BloomreachDataSource's spacing gate. Concurrent requests get their own ALS frames; the runtime keeps them apart automatically.

```
  Pattern — ALS context propagation through awaits

  request A frame                request B frame
  ──────────────                 ──────────────
  ALS.run({store: A_store}, ──   ALS.run({store: B_store}, ──
   async () => {                   async () => {
     await op1();                    await op1();
     // ALS.getStore() === A_store   // ALS.getStore() === B_store
     await op2();                    await op2();
     // STILL A_store                // STILL B_store
   })                              })
```

If you remove the `ALS.run` wrapper, every `getStore()` returns `undefined` and the code falls through to the dev-file or memory backend — which in production would mean *no* auth state, and the OAuth flow would fail on the first redirect.

#### Move 2.3 — what BREAKS without each part

Strip each piece out and name what fails:

  → **Drop `AsyncLocalStorage`, keep the request-store object.** Two concurrent OAuth flows on one warm instance: A and B both `writeAll` to the same dev-file backend (in dev) or both miss the production cookie path entirely. PKCE verifiers stomped. Auth fails for one of them.
  → **Drop `await` from the spacing-gate Promise.** The `setTimeout` fires later, but the function doesn't suspend — it returns immediately and the next `transport.callTool` goes out without the gap. Bloomreach 429s after the second call.
  → **Replace the spacing-gate Promise with a sync `while (Date.now() - start < ms) {}` spin-wait.** The entire event loop blocks for 1.1s. No other request makes progress, no NDJSON chunk drains, no fetch resolves. Catastrophic.

The pattern: in a single-threaded async runtime, sync work is the enemy. Every long wait must be a Promise that yields.

#### Move 2.4 — the NDJSON read loop as event-loop citizen

Same shape on the client side. `lib/streaming/ndjson.ts:31-51`:

```ts
// lib/streaming/ndjson.ts:31-51 (excerpted, annotated)
const reader = body.getReader();
const decoder = new TextDecoder();
let buf = '';
while (true) {
  if (opts?.cancelOn?.()) {
    await reader.cancel();             // ← yields
    return;
  }
  const { value, done } = await reader.read();    // ← yields per chunk
  if (done) break;
  buf += decoder.decode(value, { stream: true }); // ← sync, fast
  const lines = buf.split('\n');                  // ← sync, fast
  buf = lines.pop() ?? '';
  for (const raw of lines) {
    ...
    onEvent(JSON.parse(line) as E);               // ← sync — caller's setState fires here
  }
}
```

Each `await reader.read()` yields the browser's main thread, letting React render whatever was queued from the previous chunk. The sync work between chunks (parse, split, dispatch) had better be cheap — and it is; one chunk is one NDJSON line, one JSON parse, one event dispatch.

If we did heavy sync work between reads, we'd jank the browser's rendering. We don't.

### Move 3 — the principle

The event loop is a **cooperative scheduler**: it can only switch tasks at points your code voluntarily yields. Everything you await is a yield point; nothing you don't await is. Master that one rule and you can reason about every concurrency question this codebase raises without ever reaching for a lock.

## Primary diagram

```
  Event loop + AsyncLocalStorage + microtask queue — the whole picture

  ┌─ Node main thread ─────────────────────────────────────────────────┐
  │                                                                     │
  │  ┌─ ALS frame: request A ──────────┐  ┌─ ALS frame: request B ──┐   │
  │  │  ctx = {store: A_state, dirty}  │  │  ctx = {store: B_state} │   │
  │  └────────────┬───────────────────┘  └────────────┬───────────┘   │
  │               │                                    │                │
  │               ▼ (handler async work)               ▼                │
  │      ┌────────────────┐                  ┌────────────────┐         │
  │      │ await fetch()  │                  │ await call()   │         │
  │      │ (yield)        │                  │ (yield)        │         │
  │      └────────┬───────┘                  └────────┬───────┘         │
  │               │                                    │                │
  │               ▼ resolved                           ▼ resolved       │
  │       ┌─────────────────────────────────────────────────┐           │
  │       │  microtask queue:                                │           │
  │       │   ─ A's continuation (carries A's ALS ctx)       │           │
  │       │   ─ B's continuation (carries B's ALS ctx)       │           │
  │       │   ─ NDJSON onEvent dispatch                      │           │
  │       └────────────────┬────────────────────────────────┘           │
  │                        │ drain first                                │
  │                        ▼                                            │
  │       ┌─────────────────────────────────────────────────┐           │
  │       │  libuv timers phase:                             │           │
  │       │   ─ spacing gate setTimeout fires                │           │
  │       │   ─ retry sleep fires                            │           │
  │       └─────────────────────────────────────────────────┘           │
  │                                                                     │
  └─────────────────────────────────────────────────────────────────────┘
```

## Elaborate

`AsyncLocalStorage` is Node's answer to a problem every async server eventually hits: "how do I correlate logs, propagate request IDs, or carry per-request context without threading it through every function argument?" Java solved it with `ThreadLocal`; Go solved it with `context.Context` as the first argument to every function; Node landed on `AsyncLocalStorage` after several iterations (originally `domain` module, then `async_hooks`, finally the high-level ALS wrapper).

The microtask vs timer distinction (ECMAScript microtasks vs libuv timers) is the source of a lot of subtle ordering bugs. `Promise.resolve().then(fn)` runs *before* any pending `setTimeout(fn, 0)`. If you ever need to "yield to the next macro tick" without a delay, `setImmediate` (or `setTimeout(..., 0)`) is the lever; `await Promise.resolve()` only drains the microtask queue.

Worth reading: the Node.js docs page on the event loop phases (`docs/guides/event-loop-timers-and-nexttick.md`); the V8 blog post on how microtasks compose with Promises; Bert Belder's "Everything you need to know about the libuv event loop" talk.

## Interview defense

**Q: Why does `BloomreachDataSource` use `await new Promise(r => setTimeout(r, x))` instead of a `while` loop spinning until the time is up?**

Because a spin-wait blocks the entire Node event loop for the duration. There's one thread; if I burn 1.1s in a tight loop, every other concurrent request stalls, every NDJSON chunk waiting to drain hangs, every fetch resolves into a queue with no consumer.

The Promise+setTimeout pattern yields. The current frame suspends, libuv runs other I/O callbacks, the timer fires, the microtask queue puts our continuation back. We've slept without blocking.

Anchor: "every long wait must yield — sync wait blocks one thread, async wait blocks one task."

```
  sync wait                 async wait
  ─────────                 ──────────
  while (t < deadline) {}   await new Promise(r => setTimeout(r, ms))
       ↓                          ↓
  thread blocked            ONE task suspended
  no other work runs        other tasks free to run
```

**Q: What does `AsyncLocalStorage` actually do, and what would break without it?**

It threads a per-request object through every `await` inside an async chain, so any deep callee can call `ALS.getStore()` and see the *same* object the request handler set up — even though the call stack has been torn down and rebuilt across many awaits.

In this codebase it's used in `lib/mcp/auth.ts:47` to carry the OAuth cookie's decrypted contents through the entire request. The MCP SDK's OAuth provider calls `clientInformation()`, `tokens()`, `saveTokens()`, etc. from inside `client.connect(transport)` — many awaits deep. Without ALS, every one of those calls would have to be passed the request-scoped store explicitly. With ALS, they just call `requestStore.getStore()`.

If you removed it: two concurrent OAuth flows on one warm instance would either share state (security disaster — A could see B's tokens) or one would silently see no auth context at all (the cookie wouldn't be read, the OAuth flow would restart). The codebase comment at `lib/mcp/auth.ts:42-45` spells out the "each request gets its own ALS context, so concurrent requests on one instance never share state" guarantee.

```
  without ALS:  every call needs the sid as an argument
   handler(sid) → connectMcp(sid) → provider.tokens(sid) → readState(sid)
                                          (3 hops, every one needs sid)

  with ALS:     sid lives in the implicit per-request store
   handler() → connectMcp() → provider.tokens() → readState()
                                          (zero hops, all share via getStore())
```

## See also

  → `02-processes-threads-and-tasks.md` for the single-threaded model this event loop drives.
  → `04-shared-state-races-and-synchronization.md` for what awaits mean for shared `Map`s.
  → `07-backpressure-bounded-work-and-cancellation.md` for how `AbortSignal.timeout` rides the same event loop.

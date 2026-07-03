# Event loop and async I/O

**Industry:** event loop, microtasks and macrotasks, asynchronous I/O · Language-agnostic

## Zoom out — where this concept lives

Same single-threaded model as the last file, but now zoom in to the queue that decides what runs next. Everything the app does — reading a request, awaiting an MCP call, encoding an NDJSON line, checking a persisted config — is a task on one of two queues.

```
  Zoom out — where the event loop sits

  ┌─ Browser / Node ────────────────────────────┐
  │                                             │
  │  your code (async functions, event handlers)│
  │       │                                     │
  │       ▼                                     │
  │  ★ event loop ★  ← THIS FILE                 │
  │       │                                     │
  │       ▼                                     │
  │  runtime primitives (fetch, timers, fs, …)  │
  │                                             │
  └─────────────────────────────────────────────┘
```

The concept: **a scheduler that alternates between draining a microtask queue and picking one macrotask at a time**. Async I/O (fetch, fs, network) yields to the loop when it starts, and the loop wakes up the awaiter when the I/O completes. Blocking the loop = freezing everything.

## Structure pass — layers, axis, seams

Pick one axis — **when does control return to the loop?** — and trace it.

```
  One axis (when does control return?) down the layers

  ┌─ your JS ────────────────────────────────┐
  │  synchronous statement    → NOT until you │
  │                             finish        │
  │  await                    → IMMEDIATELY   │
  └──────────────────────────────────────────┘
      ↓
  ┌─ V8's promise machinery ────────────────┐
  │  microtask queue drains before the loop │
  │  moves on                                │
  └──────────────────────────────────────────┘
      ↓
  ┌─ Node's event loop phases ──────────────┐
  │  timers · pending I/O · poll · check    │
  │  each phase pulls from its own queue    │
  └──────────────────────────────────────────┘

  seam that matters: sync vs async. Below sync, no yields.
```

**The seam:** synchronous code = zero yields until you return. Async code = yields at every `await`. Between the two lies every blocking-hazard bug ever written.

## How it works

### Move 1 — the mental model

You know how `Array.prototype.map` runs synchronously and blocks — you can't have a `.map(async (x) => await …)` and expect it to await? The reason is the loop: `.map` returns immediately with a list of promises; nothing awaited them. That gap between "started the work" and "waited for the work" is the entire event loop model.

```
  Pattern — the event loop's inner cycle

  ┌── pick next macrotask (from queue) ──┐
  │                                      │
  │   ┌────────────────────────────┐    │
  │   │ run macrotask synchronously │    │
  │   │ (until it returns or awaits)│    │
  │   └────────────┬───────────────┘    │
  │                │                     │
  │                ▼                     │
  │   ┌────────────────────────────┐    │
  │   │ drain ALL microtasks       │    │
  │   │ (resolved promises, .then) │    │
  │   └────────────┬───────────────┘    │
  │                │                     │
  │                ▼                     │
  │   ┌────────────────────────────┐    │
  │   │ poll for I/O completions    │    │
  │   │ (fetch resolved, fs done)   │    │
  │   └────────────┬───────────────┘    │
  │                │                     │
  └────────────────┴─────────────────────┘

  drain microtasks between EVERY macrotask
```

The two queues (microtask + macrotask) is the trap. If you enqueue a new microtask *inside* the microtask drain, it gets drained too. An infinite chain of `.then().then()...` blocks the loop forever without ever running a timer or I/O callback. That's "microtask starvation."

### Move 2 — the pieces that matter here

#### Async fetch and NDJSON streaming

The heaviest async work in the repo is the NDJSON stream from `app/api/agent/route.ts` back to the browser. The server writes chunks into a `ReadableStream` (`app/api/agent/route.ts:189-193`); the browser reads with `readNdjson` in `useInvestigation`. Both sides are await-driven — no blocking.

Server side, one investigation event produces one enqueue:

```
  // app/api/agent/route.ts:192-195 — send is the enqueue path
  const send = (e: AgentEvent) => {
    collected.push(e);
    controller.enqueue(encoder.encode(encodeEvent(e)));
  };
```

Each `send()` runs synchronously — no await — so many events can go out in one macrotask if they're generated back-to-back. Between agent-loop turns (which do await the model), the loop yields, the browser reads the buffered chunk, and the next macrotask runs.

Client side, `readNdjson` reads bytes → splits on `\n` → calls a handler per line. Because the handler is synchronous (`lib/hooks/useInvestigation.ts:99-153` is a big `switch` with `setState` calls) and React 19 batches `setState`, one chunk becoming many events becomes one render pass, not many.

#### The 30s per-call MCP timeout is a race between promises

`lib/mcp/transport.ts:131` composes signals — the client's cancel signal OR a 30s `AbortSignal.timeout` — with `AbortSignal.any`. The MCP SDK internally does `fetch(url, { signal })`. When either signal fires, the fetch rejects with `AbortError`.

The key subtlety: `AbortSignal.timeout(30_000)` isn't a `setTimeout` you have to clean up. It's the runtime's timeout primitive that automatically aborts the signal when the timer fires. Under the hood, that IS a macrotask on the timer queue — the event loop's `timers` phase picks it up and dispatches. If the main thread is blocked (a synchronous loop that never yields), the timer fires late and the timeout is effectively longer than 30s. Not a problem here because we don't block; worth knowing as the failure mode.

```
  Layers-and-hops — how a 30s timeout actually fires

  ┌─ transport.ts ─────────────┐   compose signal (route + 30s timeout)
  │  callTool()                │   ─────────────────►
  └────────────┬───────────────┘
               │
               ▼
  ┌─ MCP SDK client ───────────┐   hop: pass signal into fetch
  │  client.callTool()         │   ─────────────────►
  └────────────┬───────────────┘
               │
               ▼
  ┌─ Node fetch (undici) ──────┐   hop: reject with AbortError
  │  waits on socket / signal  │   ◄────────── first signal to fire wins
  └────────────┬───────────────┘
               │
               ▼
  ┌─ V8 timer queue ───────────┐
  │  AbortSignal.timeout(30s)  │  ← lives here as a macrotask
  │  fires only when this      │
  │  phase of the loop runs    │
  └────────────────────────────┘
```

#### Runtime detection for browser-only APIs

`lib/mcp/config.ts:80` uses runtime detection instead of environment flags:

```
  // lib/mcp/config.ts:77-82 — btoa/Buffer runtime split
  export function encodeConfigHeader(config: McpConfigOverride): string {
    const json = JSON.stringify(normalizeConfig(config));
    // btoa is available in browsers; Node has Buffer. Runtime detection.
    if (typeof btoa === 'function') return btoa(json);
    return Buffer.from(json, 'utf8').toString('base64');
  }
```

This is not about the event loop directly, but about *which* runtime you're on. The reason it matters here: if the config module were imported into a browser bundle with `Buffer` at the module top level, the bundler would inline all of `node:buffer` into the client bundle — hundreds of KB of code that will never run. Runtime detection avoids the import at module load, avoids the bundle bloat, and works in both bands. Same idea for `atob` on decode (`lib/mcp/config.ts:91`).

Same shape: SSR-safety guards on localStorage. `lib/mcp/config.ts:107`, `:122`, `:143` all check `typeof localStorage === 'undefined'` first. Node has no `localStorage`; touching it would throw. The pattern is: **detect the API before you use it, don't assume the environment**.

#### Blocking hazards — where they could show up

Two synchronous operations in the repo would matter if they scaled:

1. **`readFileSync(CACHE_FILE, 'utf8')` in dev auth cache** — `lib/mcp/auth.ts:118`. In dev only (`process.env.NODE_ENV === 'development'`), the auth store reads/writes a JSON file synchronously on every provider method call. That would block the loop; dev doesn't care because there's one user. In production the ALS store replaces this path.

2. **`JSON.parse` on the cached investigation demo file** — `app/api/agent/route.ts:53`. Same story: a synchronous read of a small file. Not a hot path.

Both are marked as dev-only paths in comments. The production path is entirely async I/O.

#### Where microtask starvation would bite

The chain `.then().then().then()` never yields to the timer or I/O queue. Fortunately, no code in the repo builds a Promise chain that recursively enqueues microtasks. The agent loop awaits real I/O (fetch to Anthropic, fetch to MCP), so every turn goes through a macrotask boundary. If someone wrote a "for-each-of-1000 items do await Promise.resolve()" loop, that would starve the timer queue until it finished; it doesn't exist today.

### Move 3 — the principle

Async I/O and the event loop are one machine: I/O calls hand a callback to the loop, the loop wakes up the awaiter when the I/O is done. Every millisecond of blocking synchronous work is a millisecond nothing else runs — not another request, not a timer, not the next chunk of the same stream. On a serverless function that's fine (one user, one thread, mostly waiting on network). On a browser tab it's the difference between smooth scroll and jank. The design pattern that falls out: **do CPU work in short bursts, do I/O eagerly, prefer await over synchronous polling**.

## Primary diagram

```
  Event loop and async I/O — full picture

  ┌─ your code (route handler, hook, agent) ─────────────────────┐
  │                                                              │
  │   sync stmt   sync stmt   await ─┐   sync stmt   await ─┐    │
  │      │           │              │      │              │    │
  │      └─── run to completion ────┘      └── yields ────┘    │
  │                                                              │
  └──────────────────────────────────────┬───────────────────────┘
                                         │
                                         ▼
  ┌─ V8 promise + microtask machinery ───────────────────────────┐
  │                                                              │
  │   microtask queue                                            │
  │     .then callbacks · queueMicrotask · MutationObserver       │
  │   drains COMPLETELY between every macrotask                  │
  │                                                              │
  └──────────────────────────────────────┬───────────────────────┘
                                         │
                                         ▼
  ┌─ event loop phases (Node's model) ───────────────────────────┐
  │                                                              │
  │   ┌─ timers ─┐  ┌─ I/O ─┐  ┌─ poll ─┐  ┌─ check ─┐          │
  │   │ setTimeout│  │ fs / │  │ waits │  │ setImmediate│         │
  │   │ signal   │  │ net  │  │ for I/O│  │            │          │
  │   │ .timeout │  │      │  │       │  │            │          │
  │   └──────────┘  └──────┘  └──────┘  └────────────┘          │
  │                                                              │
  │   microtask drain runs between every phase transition        │
  └──────────────────────────────────────────────────────────────┘

  hazards this design avoids:
    · sync file/net reads (except tiny dev-only paths)
    · long promise chains that starve timers
    · Buffer.from at module top level (bundle bloat)
    · touching localStorage on the server (SSR crash)
```

## Elaborate

The two-queue model (microtasks + macrotasks) is a compromise. Microtasks let you handle "the promise just resolved, do the next thing" without a full loop turn; macrotasks let real I/O and timers get their say. If everything were a microtask, the loop would never breathe. If nothing were, promises would feel laggy.

Node's phased loop (timers → pending → poll → check → close) is Node-specific; browsers have a simpler "tasks and microtasks" model driven by the HTML spec. For the purposes of writing app code, treating them as "microtasks first, then one macrotask" is close enough. The difference matters when you're debugging why a `setImmediate` runs before or after a `setTimeout(fn, 0)` — a rabbit hole `blooming_insights` never goes down.

Read `04-shared-state-races-and-synchronization.md` next: it takes the "every await is a yield point" fact from this file and turns it into a design pattern (ALS per-request scoping). Then `05-memory-stack-heap-gc-and-lifetimes.md` walks how allocations across many async task chains interact with the GC.

## Interview defense

**Q: What actually happens when I write `await someFetch()`?**

The `await` desugars to a `.then` on the promise. Your function *pauses* — its remaining lines become a callback registered on the promise. Control returns to the event loop. The loop picks the next task. When the fetch's underlying I/O completes (usually via libuv on Node, the network stack on the browser), the runtime resolves the promise. That resolution enqueues your callback on the microtask queue. On the next microtask drain — which happens between every macrotask — your remaining code runs.

*Diagram to sketch: two horizontal timelines — "your code" and "event loop" — with an arrow from `await` down into a "microtask queue" box, then back up to "your code resumes" after the I/O box.*

**Q: What blocks the event loop in `blooming_insights`?**

Nothing in production, by design. In dev, `lib/mcp/auth.ts:118` does `readFileSync` for the auth cache — but that's guarded by `NODE_ENV === 'development'` and never runs on Vercel. In production the same code path goes through the ALS-scoped cookie store, which is all sync-but-tiny reads (dict lookups on a small object). The agent loop awaits real network I/O, so the loop breathes on every turn. The one *theoretical* blocker would be a runaway synchronous loop in an agent tool's result-processing — we truncate results at 4000 bytes (`TRUNC = 4000`) partly to keep JSON.parse cheap.

*Diagram to sketch: the loop-cycle diagram with red X marks on "sync file read" and "long JSON.parse" and green checks on "await fetch," "await callTool," "await messages.create."*

**Q: The load-bearing part people forget about the event loop?**

Microtasks drain to *completion* before the loop moves on. If you build a chain of `Promise.resolve().then().then()...` that keeps enqueuing new microtasks, the loop never gets to run timers or I/O completions. The load harness never triggers this because the worker pool awaits real network I/O on every turn — but it's the failure mode you'd hit if you wrote a "synchronously batch 10000 things" helper that pretended to be async.

*Diagram to sketch: the loop-cycle with the microtask box growing indefinitely, arrows from the box back into itself, and the timer phase greyed out and starving.*

## See also

- `02-processes-threads-and-tasks.md` — the single-thread rule this file builds on
- `04-shared-state-races-and-synchronization.md` — what "every await is a yield" means for shared state
- `07-backpressure-bounded-work-and-cancellation.md` — how AbortSignal composes with the event loop's timer phase

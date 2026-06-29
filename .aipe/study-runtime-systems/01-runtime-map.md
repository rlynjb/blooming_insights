# Runtime Map

**Industry name:** execution-context map · **Type:** Project-specific

## Zoom out — where this concept lives

Before any concept file walks a mechanism, you need the map. This file IS the map. Every other file in this folder zooms into one band of it.

```
  Zoom out — the three bands and what runs in each

  ┌─ Browser (Chromium/Safari/Firefox) ──────────────────────────────────┐
  │  React 19 main thread                                                │
  │  ★ THIS FILE MAPS THIS BAND ★                                        │
  │  - useBriefingStream / useInvestigation (lib/hooks)                  │
  │  - readNdjson pull-loop (lib/streaming/ndjson.ts)                    │
  │  - fetch() AbortController (cleanup → cancelledRef → cancel reader)  │
  └────────────────┬─────────────────────────────────────────────────────┘
                   │  HTTPS · NDJSON over ReadableStream
  ┌─ Vercel platform ──▼─────────────────────────────────────────────────┐
  │  Serverless function instance pool (opaque to the app)               │
  │  ★ THIS FILE MAPS THIS BAND ★                                        │
  │  - maxDuration = 300s per function invocation                        │
  │  - instances may be warm (reused) or cold (fresh process)            │
  │  - between-instance state must travel via cookies / external store   │
  └────────────────┬─────────────────────────────────────────────────────┘
                   │  spawns / reuses
  ┌─ Node 20+ process (ONE) ▼────────────────────────────────────────────┐
  │  Single-threaded JavaScript event loop                               │
  │  ★ THIS FILE MAPS THIS BAND ★                                        │
  │  - module-level state (lib/state/*, lib/mcp/schema.ts cache)         │
  │  - AsyncLocalStorage per-request store (lib/mcp/auth.ts)             │
  │  - per-request DataSource instances (lib/data-source/index.ts)       │
  │  - in-flight Promises owned by ReadableStream controllers            │
  └──────────────────────────────────────────────────────────────────────┘
```

The browser band exists because the product is a streaming UI; cut it and the agent's reasoning never reaches a user. The Vercel band exists because that's where the code is deployed; cut it and there's no public entry point. The Node band is the actual app — everything in `lib/` runs here.

## Structure pass — axes through the three bands

One question, traced top to bottom, across all three bands. Hold the question still; watch the answer change.

**Axis: lifetime — how long does this thing live?**

```
  Lifetime per band — the answer flips twice

  ┌─ Browser ────────────────────────────────────────────────┐
  │  React state    → lives across renders (until refresh)   │
  │  sessionStorage → lives across navigations within tab    │
  │  the fetch      → dies when reader closes or aborts      │
  └─────────────────────────┬────────────────────────────────┘
                            │ (seam: HTTPS request boundary)
  ┌─ Vercel ────────────────▼────────────────────────────────┐
  │  function instance → unspecified; may warm-reuse or cold │
  │  request           → 300s max, killed by platform        │
  │  cookies (bi_*)    → 10 days, encrypted, travel w/ user  │
  └─────────────────────────┬────────────────────────────────┘
                            │ (seam: Node process boundary)
  ┌─ Node process ──────────▼────────────────────────────────┐
  │  module-level Map  → as long as the process is warm      │
  │  ALS context       → as long as one request's async tree │
  │  DataSource inst.  → constructed per request, GC'd after │
  └──────────────────────────────────────────────────────────┘
```

Three lifetime answers in one stack. That triple-jump is what every isolation bug in the system lives inside. ALS protects the request-scoped slot (`lib/mcp/auth.ts:91`); session-keyed Maps protect the cross-request slot (`lib/state/insights.ts:8-23`); the cookie protects the cross-instance slot (`lib/mcp/auth.ts:86-104`). When something forgets which lifetime it lives at — `lib/mcp/schema.ts:138`'s bare `let cached` is the example — users see each other's data.

**Axis: ownership — who decides when this dies?**

- Browser band: the user (close tab, navigate, refresh).
- Vercel band: the platform (timeout, scale-down, instance recycle).
- Node band: the V8 garbage collector (when nothing references it).

Three different owners. The app cannot reach across these seams to "kill" something on the other side. The closest it gets is `req.signal` traveling DOWN (browser → Vercel → Node async tree); nothing travels UP except the NDJSON bytes and the eventual HTTP status.

**Axis: state-sharing — what's visible across what?**

The most consequential one. Walk it left to right:

```
  State-sharing surface — who can see what

  inside one request          across requests          across instances
  ─────────────────           ────────────────         ─────────────────
  React component state       module-level Maps        encrypted cookies
  ALS-scoped requestStore     (session-keyed!)         (bi_session, bi_auth)
  per-request DataSource      lib/mcp/schema.ts        sessionStorage
                                cached (LEAKS! ← see   (bi:insight:*, bi:diag:*)
                                finding #1)            localStorage (bi:mode)
```

The seams between these columns are where bugs live. Reading the first column is fine — it's request-scoped. Reading the second when you only meant the first is a cross-session leak. Reading the third when you only meant the second is a cross-instance staleness bug. The four-file walk in `04-shared-state-races-and-synchronization.md` traces each one.

## How it works

### Move 1 — the mental model

Picture a single Node process as a one-pane kitchen. There's one cook (the event loop). Orders (HTTP requests) arrive at a window; the cook starts each, sets timers, walks away while things cook, and comes back when something pings. There's no second cook — there's no race over the stove because there's only one stove. The trick is that the cook holds a notepad (`AsyncLocalStorage`) that flips between orders so each request's notes stay separate, and there are some ingredients on the shelf (module-level Maps) that ANY order can grab — those are where mistakes happen.

```
  The one-pane kitchen — one event loop, many orders

  ┌──────────────────────────────────────────────────────┐
  │   THE EVENT LOOP (one)                               │
  │                                                      │
  │   order #1 ──┐                                       │
  │              ├─► tasks → microtasks → I/O callbacks  │
  │   order #2 ──┘                                       │
  │                                                      │
  │   ALS notepad: flips per order (request-scoped)      │
  │   module shelf: shared across orders                 │
  └──────────────────────────────────────────────────────┘

  the question every concept file answers: which shelf does this
  thing live on, and does it know its lifetime?
```

### Move 2 — the four resource classes

The Node band holds four classes of resource. Each has a different lifetime and a different containment story.

#### Process-lifetime resources (the warm instance)

What lives as long as the Node process itself. On Vercel a warm instance may serve dozens of requests before recycling.

```
  Process-lifetime — survives between requests

  ┌─ module-level constants ──────────────────────────────┐
  │  AGENT_MODEL = 'claude-sonnet-4-6'                    │
  │  TOOL_TIMEOUT_MS = 30_000                             │
  │  ... (immutable; safe)                                │
  └───────────────────────────────────────────────────────┘
  ┌─ module-level Maps ───────────────────────────────────┐
  │  state: Map<sessionId, SessionFeed>                   │
  │  mem:   Map<insightId, AgentEvent[]>                  │
  │  memStore: Map<sessionId, SessionAuthState>           │
  │  ... (mutable; MUST be session-keyed)                 │
  └───────────────────────────────────────────────────────┘
  ┌─ module-level singletons ─────────────────────────────┐
  │  let cached: WorkspaceSchema | null                   │ ← LEAKS
  └───────────────────────────────────────────────────────┘
```

The third one is finding #1 in the audit. `lib/mcp/schema.ts:138` declares `let cached: WorkspaceSchema | null = null`, and `bootstrapSchema` at line 190 reads/writes it without keying on session. The first request to a warm instance populates `cached`; the second request returns it regardless of which Bloomreach project the second user has authorization for. Every other module-level mutable in this codebase is correctly session-keyed — this one isn't.

The session-keyed Maps work like this:

```ts
// lib/state/insights.ts:14-23 — session-keyed module-level state
const state = new Map<string, SessionFeed>();

function sessionState(sessionId: string): SessionFeed {
  let s = state.get(sessionId);
  if (!s) {
    s = { insights: new Map(), investigations: new Map(), anomalies: new Map() };
    state.set(sessionId, s);
  }
  return s;
}
```

The outer map is never cleared — clearing it would wipe other users' feeds mid-briefing. Each session gets a sub-map; `putInsights` clears only THIS session's sub-map (`lib/state/insights.ts:57-71`). The comment at line 4 explicitly calls out the cross-session bleed it prevents.

#### Request-lifetime resources (the async tree)

What lives only for one request, traveling down the async call tree from the route handler.

```ts
// lib/mcp/auth.ts:46-47, 86-104 — ALS-scoped per-request store
interface RequestStore { store: Store; dirty: boolean }
const requestStore = new AsyncLocalStorage<RequestStore>();

export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();
  const { cookies } = await import('next/headers');
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
  const result = await requestStore.run(ctx, fn);   // ← every async descendant sees `ctx`
  if (ctx.dirty) {
    (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), { /* ... */ });
  }
  return result;
}
```

`requestStore.run(ctx, fn)` enters an async context. Every `await` inside `fn` and every promise it spawns sees the same `ctx` via `requestStore.getStore()` (`lib/mcp/auth.ts:114, 126`). When `fn` returns, the context exits. Two concurrent requests on the same warm instance each call `withAuthCookies`, each get their own `ctx`, and never see each other's store — that's what ALS buys you on a single-threaded runtime.

The `04-shared-state-races-and-synchronization.md` file walks this in full, including why the cookie round-trip exists (Next's request-vs-response cookie split).

#### In-flight resources (Promises and stream controllers)

What lives only until an asynchronous operation completes or aborts.

```ts
// app/api/agent/route.ts:184-340 — a ReadableStream controller is a resource
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    // ... lots of agent work ...
    try {
      // ... emit events via controller.enqueue ...
    } catch (e) {
      // ... emit error event ...
    } finally {
      try { await disposeDataSource(); } catch { /* swallow */ }
      controller.close();   // ← the explicit teardown
    }
  },
});
```

The controller is alive as long as `start()` hasn't returned. Inside `start`, the route handler owns ALL the work: bootstrap, listTools, intent classify, agent loops, NDJSON emission. The `finally` block is the only place that's guaranteed to run on every exit path (including client abort), and it does two things: call `disposeDataSource()` and `controller.close()`. Without `controller.close()`, the browser's reader would hang forever waiting for more bytes that won't come.

The pattern is identical in `app/api/briefing/route.ts:191-329`. Both routes treat the controller as the resource and pin its lifetime to the route handler's async tree.

#### Browser-lifetime resources (cleanup-bound effects)

In the browser band, React's `useEffect` cleanup is the disposal hook. The hooks in `lib/hooks/` split into two camps based on whether cancellation is desired.

```
  Two cleanup stories — same primitive, opposite policy

  ┌─ useBriefingStream (cancels on cleanup) ───────────────┐
  │  cancelledRef.current = false  (effect start)          │
  │  readNdjson(..., { cancelOn: () => cancelledRef.current})│
  │  return () => { cancelledRef.current = true; }         │ ← cleanup cancels
  └────────────────────────────────────────────────────────┘
  ┌─ useInvestigation (does NOT cancel on cleanup) ────────┐
  │  startedRef.current set true on first mount            │
  │  no cancel callback on cleanup                         │
  │  ── deliberate: StrictMode would otherwise abort dev   │
  └────────────────────────────────────────────────────────┘
```

The contrast is the lesson. Both hooks face React 19 StrictMode (which mounts → cleans up → re-mounts in dev). `useBriefingStream` reaches for the standard "cancel on cleanup" pattern but guards against double-firing with a fresh `cancelledRef` per effect run (`lib/hooks/useBriefingStream.ts:130, 152, 297-299`). `useInvestigation` (`lib/hooks/useInvestigation.ts:36-37, 44-49`) reaches for the OPPOSITE pattern: don't cancel, gate with `startedRef` so re-mounts don't double-fetch. The comment explains why: aborting the first mount's fetch when StrictMode runs cleanup left the trace empty.

This split is real and intentional. The cost — an investigation kept running when its tab closes — is finding #4 in the audit.

### Move 3 — the principle

The runtime map is a lifetime map. Every resource in the system has an owner, a lifetime, and a containment scope. The bugs cluster at the seams between scopes: something written assuming request lifetime that actually has process lifetime (the schema cache leak), something written assuming process lifetime that actually has request lifetime (the would-be bug if `BloomreachDataSource` were module-scoped instead of per-request), something written assuming browser lifetime that actually has Vercel-instance lifetime (the demo capture file system — `06-filesystem-streams-and-resource-lifecycle.md` walks why it works in dev and silently no-ops in prod).

When you read any other file in this folder, hold the question: *which lifetime does this resource live at, and does the code know?*

## Primary diagram — the recap

```
  The full map: three bands, three lifetimes, three isolation mechanisms

  ┌─ Browser tab ────────────────────────────────────────────────────────┐
  │  React component state · sessionStorage (per-tab) · localStorage     │
  │  Isolation: per-tab by the browser's same-origin policy              │
  └────────────────┬─────────────────────────────────────────────────────┘
                   │  HTTPS · req.signal travels DOWN
  ┌─ Vercel ────────▼────────────────────────────────────────────────────┐
  │  Function instance pool · maxDuration=300s · ephemeral or warm       │
  │  Isolation: encrypted cookies (bi_session, bi_auth) cross instances  │
  └────────────────┬─────────────────────────────────────────────────────┘
                   │  spawns/reuses
  ┌─ Node process ──▼────────────────────────────────────────────────────┐
  │                                                                      │
  │   ┌─ process-lifetime ────────────────────────────────────────────┐  │
  │   │  module-level Maps (session-keyed) · `cached` (LEAKS, #1)     │  │
  │   └───────────────────────────────────────────────────────────────┘  │
  │                                                                      │
  │   ┌─ request-lifetime (ALS) ──────────────────────────────────────┐  │
  │   │  requestStore (auth.ts:47) · per-request DataSource           │  │
  │   └───────────────────────────────────────────────────────────────┘  │
  │                                                                      │
  │   ┌─ in-flight (Promise/controller) ──────────────────────────────┐  │
  │   │  ReadableStream controllers · agent loop turns · MCP calls    │  │
  │   │  Bounded by req.signal OR AbortSignal.timeout(30000) (first   │  │
  │   │  to fire wins) — see 07-backpressure-bounded-work-...         │  │
  │   └───────────────────────────────────────────────────────────────┘  │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This map is the substrate the rest of this guide builds on. The pattern of "one process, many lifetimes, ALS for request scoping" is the standard Node serverless shape — it's what `next/headers` assumes, what Vercel's runtime is tuned for, what every Anthropic SDK example takes for granted. The interesting question isn't "is this the right shape?" (it is) but "where does the shape break down in THIS codebase?"

The four classes — process / request / in-flight / browser — are the working vocabulary for every later file. When `04-shared-state-races-and-synchronization.md` says "this is request-scoped," it means class 2. When `05-memory-stack-heap-gc-and-lifetimes.md` says "this leaks across requests," it means class 1 holding what should be class 2.

## Interview defense

> Q: "Walk me through the runtime model of this app."

Three bands. Browser, Vercel, Node. Inside the Node band, four resource lifetimes: process (warm instance memory), request (ALS-scoped), in-flight (Promises and stream controllers), and browser (effect cleanup). The interesting decisions all happen at the seams between these lifetimes — that's where ALS lives, where the session-keyed Maps live, where the per-call AbortSignal composes with the route's req.signal.

> Q: "What's the load-bearing part most people forget?"

`AsyncLocalStorage`'s lifetime. It's not a global — it's a per-async-tree context. The mistake is reading from the module-level Map when you meant the ALS slot, or vice versa. The schema cache in `lib/mcp/schema.ts` is the example of that mistake actually shipping: it's at module level when it should be in either the ALS slot or a session-keyed Map.

> Q: "Why one process and not workers?"

Vercel serverless gives you one process per function invocation. Adding workers would mean spawning threads inside that one process to do parallel CPU work — but this app's hot path is I/O-bound (Anthropic API + Bloomreach MCP), not CPU-bound. The event loop already handles concurrent I/O cleanly; workers would add complexity without removing latency. The previous Olist SQL adapter was a subprocess (separate Node process) for isolation, not parallelism, and it was retired.

## See also

- `02-processes-threads-and-tasks.md` — drills into the single-process model and what fills the "no threads" space.
- `04-shared-state-races-and-synchronization.md` — drills into ALS and the session-keyed Maps.
- `05-memory-stack-heap-gc-and-lifetimes.md` — drills into the lifetime axis specifically.
- `07-backpressure-bounded-work-and-cancellation.md` — drills into the AbortSignal composition and the 300s budget.
- `08-runtime-systems-red-flags-audit.md` — ranked list of the runtime risks visible from this map.

# Memory, stack, heap, GC, and lifetimes

**Industry:** memory model, garbage collection, allocation lifecycles · Language-agnostic

## Zoom out — where this concept lives

Every band on the runtime map has a heap that V8 owns and a GC that reclaims it when references go away. The memory pressure story in `blooming_insights` is quiet — small objects, short-lived requests, no big buffers — but the lifetime rules (what stays alive on a warm instance, what dies with a request, what dies with a tab) are load-bearing.

```
  Zoom out — where memory lives

  ┌─ Browser ──────────────────────────────────────────┐
  │  V8 heap · React fiber tree · React state          │
  │  DOM refs · fetch response bodies (streamed)       │
  │  bounded by: the tab                               │
  └───────────────────────┬────────────────────────────┘
                          │
  ┌─ Vercel serverless ──▼─────────────────────────────┐
  │  ★ THIS CONCEPT ★                                   │
  │  Node V8 heap · module-level Maps · ALS contexts   │
  │  bounded by: Vercel's instance memory ceiling      │
  └───────────────────────┬────────────────────────────┘
                          │
  ┌─ Upstream ──────────▼──────────────────────────────┐
  │  their heap, their GC                              │
  └────────────────────────────────────────────────────┘
```

The concept: **automatic memory management with distinct object lifetimes per runtime tier**. Understanding where an allocation lives (request scope vs instance scope vs page scope) tells you when the GC will reclaim it — and where a leak would hide.

## Structure pass — layers, axis, seams

Pick one axis — **when does this allocation get freed?** — and trace it down.

```
  One axis (when does this get freed?) down the layers

  ┌─ per-await stack frame ────────────────────────┐
  │  local vars, arguments      → RELEASED when    │
  │                               the async fn's    │
  │                               continuation ends │
  └────────────────────────────────────────────────┘
      ↓
  ┌─ per-request objects ──────────────────────────┐
  │  ALS RequestStore, agent  → RELEASED when the  │
  │  instances, trace arrays    ReadableStream      │
  │                              closes             │
  └────────────────────────────────────────────────┘
      ↓
  ┌─ per-instance objects ─────────────────────────┐
  │  module-level Maps, cache → RELEASED when the  │
  │  entries, SDK client       Vercel instance dies │
  │                             (minutes to hours)  │
  └────────────────────────────────────────────────┘
      ↓
  ┌─ per-tab objects (browser) ────────────────────┐
  │  React state, localStorage → RELEASED when tab  │
  │                              closes (or GC in   │
  │                              a background tab)  │
  └────────────────────────────────────────────────┘

  the seam that matters: request boundary vs instance boundary
```

**The load-bearing seam:** what dies with the request vs what survives the request. Every module-level `Map` in `lib/*` is a survival case — you're deliberately choosing "outlive this request." Every ALS context is a die-with-the-request case. Confusing them either leaks memory (Maps that grow forever) or loses data (state you needed on the next request).

## How it works

### Move 1 — the mental model

You know how a React component's local state (`useState`) dies when the component unmounts? That's a lifetime scoped to a mount. V8's GC does the same for objects: as long as *something* holds a reference (a closure, a Map entry, a React fiber), the object stays alive. When the last reference drops, the object becomes garbage. The next GC pass reclaims it.

```
  Pattern — reachability determines lifetime

  ┌─ roots (always reachable) ─────────────────────┐
  │  global object, module top-level vars,          │
  │  the current call stack, live promises          │
  └────────────┬───────────────────────────────────┘
               │  refs to
               ▼
  ┌─ your objects ─────────────────────────────────┐
  │  { user: {…}, trace: [{…}, {…}], client: {…} } │
  │                                                 │
  │  as long as SOMETHING traces back to a root,   │
  │  the whole graph stays alive                    │
  └────────────────────────────────────────────────┘

  reclamation: unreachable subgraphs get GC'd
```

The subtlety in JS: closures capture references. A callback registered on an event target keeps its captured variables alive as long as the callback is registered. A promise's `.then` callback keeps captured variables alive until the promise resolves. Getting this wrong is exactly how JS "memory leaks" happen — closures holding onto too much, forgotten timers, undeleted Map entries.

### Move 2 — the pieces

#### The Node V8 heap on Vercel

**Where it lives:** inside one Node process per warm Vercel instance. V8's default max heap is 4GB (`--max-old-space-size=4096`); Vercel's memory limit is configurable per function (default 1024MB on Pro). Whichever ceiling is lower wins.

**What survives one request:** everything at module top-level. That's:

- `const memStore = new Map<string, SessionAuthState>()` — `lib/mcp/auth.ts:36`. Test-only, but it *is* module-level.
- `const requestStore = new AsyncLocalStorage<RequestStore>()` — `lib/mcp/auth.ts:47`. The ALS itself is module-level; the contexts it scopes are per-request.
- `const state = new Map<string, SessionFeed>()` — `lib/state/insights.ts:14`. Grows one entry per session.
- `const mem = new Map<string, AgentEvent[]>()` — `lib/state/investigations.ts:11`. Grows one entry per investigation.
- `private cache = new Map<…>()` inside a DataSource instance — `lib/data-source/bloomreach-data-source.ts:122`. But the DataSource instance itself is per-request (constructed inside the route handler), so this cache dies with the request.

**What dies with the request:** the DataSource instance (and its 60s cache), the DiagnosticAgent / RecommendationAgent instances, the `collected: AgentEvent[]` array inside the ReadableStream's `start` (`app/api/agent/route.ts:191`), the ALS context. All of these are constructed inside the request handler; their references drop when the ReadableStream closes and the promise chain resolves.

```
  Layers-and-hops — allocation lifetime inside one Vercel instance

  ┌─ Vercel instance (Node process, one heap) ───────────────────┐
  │                                                              │
  │  ┌─ module-level (survives requests) ──────────────────┐    │
  │  │  memStore Map · requestStore · insights.ts state    │    │
  │  │  investigations.ts mem · MCP SDK client (per session)│   │
  │  │                                                      │    │
  │  │  grows over instance lifetime                        │    │
  │  │  dies with instance (minutes to hours)               │    │
  │  └──────────────────────────────────────────────────────┘    │
  │                        │                                     │
  │                        │  holds refs into                    │
  │                        ▼                                     │
  │  ┌─ per-request (dies with request) ───────────────────┐    │
  │  │  ALS RequestStore ctx · DataSource instance · agent │    │
  │  │  collected AgentEvent[] · trace arrays               │    │
  │  │                                                      │    │
  │  │  root: the ReadableStream + the async chain          │    │
  │  │  dropped when stream closes                          │    │
  │  └──────────────────────────────────────────────────────┘    │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

#### The MCP SDK client's per-session persistence

`connectMcp` in `lib/mcp/connect.ts` reuses an MCP SDK Client per session — the session cookie's stability means we can hold onto the connection across requests within the same session. That Client instance sits in some session-keyed Map (or gets re-created per request depending on the auth path); either way, it's an object with a WebSocket-ish transport underneath, and closing it releases the connection. `dsResult.dispose` (`app/api/agent/route.ts:186`) is the cleanup handle called in the route's `finally`.

**Failure mode this design hedges against:** if the DataSource were held module-level *and* the session cookie rotated, you'd have a stale Client holding a dead connection, still referenced from the Map. The current design constructs the DataSource per request (via `makeDataSource`) and disposes on request end. The connection reuse, when it happens, is at a lower level (the MCP client's transport pool).

#### The session-keyed Maps grow — but slowly, and get GC'd with the instance

Vercel keeps warm instances for a variable period (seconds to minutes idle, usually killed after ~15 min of no traffic). Every session that hits an instance during its lifetime adds one entry to `state` (in `insights.ts`) and one to `memStore` (in `auth.ts`, dev/test only). Nothing prunes these Maps — but nothing needs to, because the whole process dies before the Map gets big.

**When this becomes a real leak:** if the process ran for weeks (a long-running Node server, not serverless), the Maps would grow unbounded. There's no LRU eviction, no periodic sweep. The workload has never hit that shape in this repo's history, but it's worth naming as the failure mode.

#### The browser heap and React state

**Where it lives:** the browser tab's V8 heap. React 19 holds the fiber tree; components hold state via `useState`. React garbage-collects state when the component unmounts.

**What lives here per investigation page:** the `items: TraceItem[]` array in `useInvestigation` grows monotonically as agent events arrive. A typical investigation produces ~30-60 trace items. Each is small (a few hundred bytes). At the end of the run, the trace is JSON-stringified into `sessionStorage`:

```
  // lib/hooks/useInvestigation.ts:135-142 — the stash
  sessionStorage.setItem(
    stashKey(step, id),
    JSON.stringify({ items: cItems, diagnosis: cDiag, recommendations: cRecs }),
  );
```

**Where it dies:** when the user navigates away (React unmounts, the component's state goes), OR when the tab closes (`sessionStorage` cleared). `sessionStorage` has a per-origin quota (typically 5-10MB) — a runaway investigation with hundreds of trace items would eventually hit it. Today the traces are far under that.

**One subtle allocation pattern:** the `handle(e)` callback captures `cItems`, `cRecs`, `cDiag` in its closure. Those closure references keep the arrays alive as long as `handle` is registered on the NDJSON reader. When the stream ends, `readNdjson` resolves, `handle` drops out of scope, and the closure captures become collectible. Standard closure hygiene.

#### The `startedRef` latch is a tiny bit of long-lived state

```
  // lib/hooks/useInvestigation.ts:45 — one boolean per mount
  const startedRef = useRef(false);
```

`useRef` allocates one object per mount. Under React StrictMode dev, the component mounts, unmounts, remounts — the `startedRef` from the first mount gets GC'd, a fresh one is allocated on the remount. In production strict mode is off; there's one `startedRef` per real mount, dropped on unmount.

#### No leaks worth naming today

- No forgotten `setInterval` — the codebase doesn't use polling timers.
- No unclosed event listeners on the browser — React 19's `useEffect` cleanup pattern is used correctly in the hooks (except the deliberate no-cleanup on the NDJSON fetch, which is a controlled choice explained in `useInvestigation.ts:34-38`).
- No dangling promise chains — every async op the app starts is awaited or ends with a `.catch` that surfaces the error to state.

### Move 3 — the principle

Automatic GC does not mean automatic memory hygiene. Every module-level `Map`, every closure capture, every `useRef`, every `sessionStorage.setItem` is a lifetime decision you're making — sometimes explicitly, sometimes by accident. On serverless the process dying often saves you from the accidental ones; on long-running processes (your dev server, a full Node server) the same code would leak. Know which of your allocations survive one request, and why.

## Primary diagram

```
  Memory lifetimes — every scope, every layer

  ┌─ browser tab heap ───────────────────────────────────────────┐
  │  React fiber tree · component state · fetch response bodies │
  │  sessionStorage (bi:inv:*, bi:diag:*)                       │
  │  localStorage (bi:mcp_config, bi:mode)                      │
  │  dies with tab                                              │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Vercel instance heap (Node 20, V8) ─────────────────────────┐
  │                                                              │
  │  ┌─ module-level survives requests ────────────────────┐    │
  │  │                                                      │    │
  │  │  insights.ts     Map<sid, SessionFeed>  (grows /sess)│    │
  │  │  investigations  Map<invId, events>     (grows /inv) │    │
  │  │  auth.ts         memStore (dev/test only)            │    │
  │  │  auth.ts         requestStore (ALS instance)         │    │
  │  │                                                      │    │
  │  │  no LRU · nothing prunes · dies with process         │    │
  │  └──────────────────────────────────────────────────────┘    │
  │                                                              │
  │  ┌─ per-request dies with request ─────────────────────┐    │
  │  │                                                      │    │
  │  │  ALS context · DataSource · Bloomreach 60s cache     │    │
  │  │  DiagnosticAgent · RecommendationAgent · trace array │    │
  │  │  ReadableStream + its collected AgentEvent[]         │    │
  │  │                                                      │    │
  │  │  released when stream closes + finally runs          │    │
  │  └──────────────────────────────────────────────────────┘    │
  │                                                              │
  │  ┌─ per-async-frame dies at end of continuation ───────┐    │
  │  │                                                      │    │
  │  │  local vars, arguments, closure captures             │    │
  │  │  V8 optimizes short-lived allocations aggressively   │    │
  │  └──────────────────────────────────────────────────────┘    │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘

  hazards this design controls:
    · no long-running Node server (Vercel kills the process periodically)
    · no timers holding closures across requests (setInterval unused)
    · session-keyed cleanup patterns (never state.clear())
    · DataSource dispose() in route finally
    · sessionStorage per-tab (per-origin quota ~5-10MB, we're well under)
```

## Elaborate

V8's generational GC — young generation collected frequently, old generation less often — is well-suited to request-scoped allocations. Short-lived objects (the `collected` array, the trace items during a request) rarely survive to the old generation; they get reclaimed cheaply. Long-lived objects (the module-level Maps) sit in the old generation and only get scanned during full GC pauses.

The failure mode for a Node backend is usually not "the heap is too big" but "the heap fragments" (V8 handles this reasonably) or "closures capture a huge object graph that stays alive too long" (this is the classic Node leak). The repo avoids both because:

1. Every request is short-ish (< 300s).
2. The heavy objects (agent state, tool results) die with the request.
3. The only truly long-lived state is small (session ids, feed entries).

For a deeper cut: the [Node.js docs on Diagnostics](https://nodejs.org/api/) point at `--inspect` + Chrome DevTools memory profiling. In the current codebase you'd almost never need it — the heap is small and quiet. If a workload change made investigations balloon (a 10MB tool result kept in memory for the full 300s route), you'd reach for the profiler.

Read `06-filesystem-streams-and-resource-lifecycle.md` next — same theme but with I/O handles instead of pure memory objects. Then `07-backpressure-bounded-work-and-cancellation.md` for how BudgetTracker enforces work ceilings.

## Interview defense

**Q: What memory lives on a warm Vercel instance across requests?**

Four things, all in module-level Maps. The auth store (`lib/mcp/auth.ts` — `memStore` is dev/test, the ALS is the production path). The feed state (`lib/state/insights.ts` — `Map<sessionId, SessionFeed>`). The investigation cache (`lib/state/investigations.ts` — `Map<invId, AgentEvent[]>`). And the MCP SDK Client per session, when we reuse it. Everything else is per-request: the DataSource instance, the agent instances, the trace array, the ReadableStream. They all die when the route's `finally` runs and the ReadableStream closes.

*Diagram to sketch: one Vercel instance box with an inner "module-level" band (persists) and an outer "per-request" band (dies) — arrows showing the request boundary crossing.*

**Q: Could the session-keyed Maps leak memory over time?**

Not in practice, because Vercel kills instances every ~15 min of idle. The Map holds one entry per session that hit that instance, each entry is small (a handful of insights, maybe an investigation), and the whole process gets torn down periodically. If we ever moved to a long-running Node server, we'd need an LRU or a TTL — none of the Maps have those today. It's a known limitation named honestly, not a live bug.

*Diagram to sketch: a Map growing over time with an axe labeled "instance kill" chopping it back to empty.*

**Q: The load-bearing part people forget about Node memory lifetimes?**

That module-level allocations survive `import` — not just the first request. If you write `const cache = new Map()` at module top-level, that Map is created ONCE per Node process, and it stays alive for as long as the process does. On serverless that's usually fine (short lifetimes, small Maps). On a long-running server, the same code leaks unless you prune. The tell in this repo: comments in `lib/state/insights.ts:4-7` and `lib/mcp/auth.ts:26-33` explicitly name what survives and why — because getting this wrong at review time is easy.

*Diagram to sketch: two timelines — "one request" ends after seconds, "one instance" spans thousands of requests over minutes; a Map lives on the second timeline.*

## See also

- `04-shared-state-races-and-synchronization.md` — the *shape* of the module-level Maps
- `06-filesystem-streams-and-resource-lifecycle.md` — I/O handles, streams, and their cleanup
- `07-backpressure-bounded-work-and-cancellation.md` — how BudgetTracker keeps the trace array bounded

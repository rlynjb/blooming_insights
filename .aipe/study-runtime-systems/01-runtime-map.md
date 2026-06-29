# Runtime map — every process, task, resource

**Industry name:** runtime topology · **Type:** Project-specific

## Zoom out, then zoom in

Before we touch any mechanism, here's the whole machine on one page. Three runtimes. Not four. The ★-marked box is the one this file is about — the runtime *map itself*.

```
  Zoom out — the three runtimes (and what does NOT exist)

  ┌─ band 1: CLIENT — browser tab ──────────────────────────────────┐
  │  React 19  →  fetch()  →  body.getReader()  →  NDJSON loop      │
  └────────────────────────────┬────────────────────────────────────┘
                               │  HTTPS · chunked NDJSON
  ┌─ band 2: SERVER — Node 20 on Vercel ★ THIS FILE ★ ──────────────┐
  │  ONE process per cold start, reused for warm invocations.       │
  │                                                                  │
  │  ┌─ Next.js route handler (per request) ────────────────────┐   │
  │  │  ┌─ AsyncLocalStorage context ────────────────────────┐ │   │
  │  │  │  BloomreachDataSource │ SyntheticDataSource         │ │   │
  │  │  │  ├─ 60s response cache (Map)                        │ │   │
  │  │  │  ├─ minIntervalMs=1100ms spacing gate               │ │   │
  │  │  │  └─ rate-limit retry ladder                         │ │   │
  │  │  └────────────────────────────────────────────────────┘ │   │
  │  │                                                          │   │
  │  │  Session-keyed state:  Map<sessionId, SessionFeed>      │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └───────────┬────────────────────────────────┬───────────────────┘
              │  HTTPS                          │  HTTPS
  ┌─ band 3: PROVIDERS ────────────────────────▼───────────────────┐
  │  Anthropic Messages API    │    Bloomreach loomi-MCP server   │
  └────────────────────────────────────────────────────────────────┘

  NOT IN THE PICTURE: subprocess runtime (removed PR #8),
                      tsx offline eval pipeline (removed),
                      workers, queues, background jobs, DB.
```

Now zoom in — this file walks the resources in band 2 specifically, and shows their lifetimes against the others.

## Structure pass

**Axis traced across the map: lifetime — how long does each resource live?**

```
  One axis (lifetime) traced down the runtime stack

  ┌─ Vercel platform ──────────────────────────────────┐
  │  the Node PROCESS itself                           │   minutes to hours
  │  ("warm instance")                                 │   (until idle scale-down)
  └────────────────────────┬───────────────────────────┘
                           │
  ┌─ module scope ────────▼────────────────────────────┐
  │  Map<sessionId, SessionFeed>    (state/insights)   │   = process lifetime
  │  Map<insightId, AgentEvent[]>   (state/investig.)  │   = process lifetime
  │  Map<key, cached>               (per DataSource)   │   = DataSource lifetime
  └────────────────────────┬───────────────────────────┘
                           │
  ┌─ per-request ─────────▼────────────────────────────┐
  │  AsyncLocalStorage RequestStore                    │   one request
  │  ReadableStream controller + encoder               │   one request
  │  AbortSignal req.signal                            │   one request
  │  BloomreachDataSource (when live mode)             │   one request
  └────────────────────────┬───────────────────────────┘
                           │
  ┌─ per-call ────────────▼────────────────────────────┐
  │  AbortSignal.timeout(30_000) (per MCP call)        │   ≤30s
  │  setTimeout for spacing gate                       │   <1.1s
  │  Promise from fetch                                │   ≤30s
  └────────────────────────────────────────────────────┘
```

**Seams where lifetime flips:**

  → process ↔ module scope: nothing — module-scope `Map`s live exactly as long as the process.
  → module scope ↔ per-request: this is the load-bearing one. The `AsyncLocalStorage` context bridges them. A request *reads from* and *writes to* module-scope state, but only inside an ALS frame.
  → per-request ↔ per-call: `composeSignals` in `lib/mcp/transport.ts:173` ORs the request's `AbortSignal` with the per-call 30s timeout. Whichever fires first wins.

The seams are where the bugs are. The mechanics below hang on those seams.

## How it works

### Move 1 — the mental model

Picture the server as a single Node process that wakes up on a cold start, then accepts request after request without restarting. Each request mounts an `AsyncLocalStorage` frame that's invisible to the others, does its work, and unmounts — but the module-scope `Map`s it touched along the way persist into the next request. The shape:

```
  Pattern — one warm process, many ephemeral request frames

  ┌─ Node process ───────────────────────────────────────────┐
  │  module-scope:  state (Map)   ·   cache (Map)            │
  │                                                          │
  │  request A frame ┐    request B frame ┐                  │
  │  ┌─────────────┐ │    ┌─────────────┐ │                  │
  │  │ ALS context │ │    │ ALS context │ │                  │
  │  │ + signal    │ │    │ + signal    │ │                  │
  │  └──────┬──────┘ │    └──────┬──────┘ │                  │
  │         │ reads/ │           │ reads/ │                  │
  │         │ writes │           │ writes │                  │
  │         ▼        ▼           ▼        ▼                  │
  │      same module-scope Maps (shared, race-prone!)        │
  └──────────────────────────────────────────────────────────┘
```

Two frames inside one process can interleave at every `await`. The `Map`s are shared. The ALS frames are not. That's the entire model.

### Move 2 — walk the resources, lifetime by lifetime

**Process lifetime — the Node instance itself.**

A Vercel function is a Node 20 process. On cold start (no warm instance available, or after idle scale-down), Vercel spawns a new one and imports the route handler module. That import side-effects:

  → `const state = new Map<string, SessionFeed>()` in `lib/state/insights.ts:14` — fresh empty Map.
  → `const mem = new Map<string, AgentEvent[]>()` in `lib/state/investigations.ts:11` — fresh empty Map.

The process then handles requests for as long as Vercel keeps it warm (minutes to hours under traffic; idle instances scale to zero). When the process dies, both Maps die with it. The browser-side `sessionStorage` stash in `lib/hooks/useBriefingStream.ts:53` exists precisely to survive this transition.

```
  ┌─ cold start ─────────────────────────────────────────────────┐
  │  Vercel spawns node process                                  │
  │     ↓                                                         │
  │  import route handler → modules eval                          │
  │     ↓                                                         │
  │  const state = new Map(); const mem = new Map();             │  ← module init
  │     ↓                                                         │
  │  request 1 lands → handler runs → Maps mutated                │
  │     ↓                                                         │
  │  request 2 (warm) → same Maps still there                     │
  │     ↓                                                         │
  │  ... minutes pass, no traffic ...                             │
  │     ↓                                                         │
  │  Vercel SIGKILLs the process → Maps gone, no cleanup hook     │
  └───────────────────────────────────────────────────────────────┘
```

There is no graceful-shutdown story in this repo. The app does not subscribe to `SIGTERM`; there is no flush of in-flight investigations on instance teardown. That's fine because the only persistent stores the requests touch are the browser cookie/sessionStorage and the Bloomreach OAuth tokens (cookie-backed in prod via `lib/mcp/auth.ts:86`); the server-side Maps are caches.

**Per-request lifetime — the route handler invocation.**

Every `GET /api/briefing` or `GET /api/agent` creates a new request frame. The handler runs once per request and tears down its closures when the response is fully written.

What lives per-request:

  → the client-side cancel signal (`req.signal`), threaded through every async call (`app/api/agent/route.ts:226, 237, 248, 274, 290`).
  → A `ReadableStream` with one `controller` + one `encoder` (`app/api/agent/route.ts:183-185`).
  → An `AsyncLocalStorage` frame established at the top of `withAuthCookies` (`lib/mcp/auth.ts:86-104`) for any auth-touching handler.
  → A data-source adapter instance (`BloomreachDataSource`, in live mode) constructed by the factory at `lib/data-source/index.ts:67-99`. **The session-scoped one has a no-op `dispose`** — the OAuth tokens it holds live across requests via the cookie store, so we deliberately do not tear down its in-memory cache between requests. (See the comment at `index.ts:14-18`.)

```
  ┌─ per-request frame (lives ≤ 300s) ─────────────────────┐
  │                                                         │
  │  withAuthCookies(() => {                                │
  │    ALS.run({store, dirty:false}, async () => {          │
  │      // every async operation inside this lambda        │
  │      // sees the same ctx via requestStore.getStore()   │
  │      const ds = await makeDataSource(mode, sid);        │
  │      const stream = new ReadableStream({ start: ... }); │
  │      return new Response(stream, ...);                  │
  │    });                                                  │
  │  });                                                    │
  │                                                         │
  └─────────────────────────────────────────────────────────┘
```

When the lambda returns, the ALS frame unmounts. If `ctx.dirty` is true the encrypted cookie is written back; otherwise nothing leaks out.

**Per-call lifetime — one MCP round-trip.**

The smallest unit is a single `dataSource.callTool(name, args, {signal})`. The Bloomreach adapter wraps it with three time bounds:

  1. The proactive spacing gate — `await setTimeout(minIntervalMs - elapsed)` in `lib/data-source/bloomreach-data-source.ts:191-194`. Up to 1.1s of *forced wait* before the call even goes out, so two back-to-back calls cannot violate Bloomreach's ~1 req/s budget.
  2. The per-call 30s ceiling — `AbortSignal.timeout(30_000)` composed into the call's signal at `lib/mcp/transport.ts:131`.
  3. The rate-limit retry ladder — up to 3 retries at server-stated waits (capped at 20s each), `bloomreach-data-source.ts:163-174`. Worst-case single-call wall-time: 1.1s spacing + 30s call + 3×20s retry = ~91s.

Here's the actual liveCall body, annotated:

```ts
// lib/data-source/bloomreach-data-source.ts:190-205
private async liveCall(name, args, signal?: AbortSignal): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));  // ← gate
  }
  try {
    const result = await this.transport.callTool(name, args, { signal });   // ← 30s ceiling inside
    this.lastCallAt = Date.now();
    return result;
  } catch (err) {
    this.lastCallAt = Date.now();                                            // ← mark even on failure
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}
```

The `lastCallAt` update on both success and failure is the load-bearing detail — without the catch branch, a failed call would let the *next* call fire immediately and burn the rate limit.

### Move 3 — the principle

The runtime map for a serverless Node app is **shorter than you think** — process, request, call, plus whatever the runtime threads across them (ALS for per-request, modules for per-process). When you can name every long-lived resource and every short-lived one, and which seam each crosses, you can predict every race and every leak before they happen. The work of this guide is making that map small enough to hold in one head.

## Primary diagram

```
  The runtime map — every resource by lifetime, every seam labelled

  process (cold start → idle scale-down, minutes-hours)
  ─────────────────────────────────────────────────────
   module-scope Map<sessionId, SessionFeed>           ← lib/state/insights.ts:14
   module-scope Map<insightId, AgentEvent[]>          ← lib/state/investigations.ts:11

      │  seam: ALS frame  bridges process-scope ↔ request-scope
      ▼

  request (≤300s, one per fetch)
  ──────────────────────────────
   AsyncLocalStorage RequestStore                     ← lib/mcp/auth.ts:47
   req.signal (AbortSignal)                           ← Next.js platform
   ReadableStream controller + encoder                ← app/api/agent/route.ts:183
   BloomreachDataSource instance                      ← lib/mcp/connect.ts:96
     ├─ Map<key, cached> (60s TTL)                    ← bloomreach-data-source.ts:122
     └─ lastCallAt: number                            ← bloomreach-data-source.ts:191

      │  seam: composeSignals  ORs request-signal ↔ per-call timeout
      ▼

  per-call (≤30s + ≤60s retries)
  ─────────────────────────────
   AbortSignal.timeout(30_000)                        ← lib/mcp/transport.ts:131
   spacing-gate setTimeout (≤1100ms)                  ← bloomreach-data-source.ts:193
   fetch() in @modelcontextprotocol/sdk transport
```

## Elaborate

The three-band model comes straight from the constraints of serverless: no daemon, no subprocesses (the platform charges per-invocation), no shared filesystem between instances. That removes a lot of vocabulary other runtimes lean on — there are no worker threads to coordinate, no IPC channels to design, no `forever` daemon to monitor. What's left is a very thin map.

The price you pay is that the map is **so** thin that what little persistent state you have (module-scope Maps) is also the most fragile (any cold start nukes it). The codebase pushes durable state to the browser (`sessionStorage`, encrypted cookie) and to the provider (Bloomreach holds the OAuth tokens via DCR + the cookie holds the access tokens). Module-scope Maps are caches — the cookie is the source of truth.

Worth reading after this: *Designing Data-Intensive Applications* ch. 11 (stream processing) for what "warm instance + ephemeral state" looks like at scale; the MCP SDK's `StreamableHTTPClientTransport` source for how the per-call signal actually composes with the SSE-style transport.

## Interview defense

**Q: How many runtimes does blooming insights have, and which ones?**

Three: a browser tab running React 19, a Vercel Node 20 process, and the two HTTP providers (Anthropic Messages API + Bloomreach loomi-MCP). I'd draw the three-band diagram. There's no fourth runtime — no subprocess, no worker, no background daemon. An olist MCP subprocess existed briefly in Phase 2 and was removed in PR #8. The Bloomreach adapter is a pure-HTTP fetch path, and the synthetic adapter is in-process.

Anchor: "one cold-start Node process, reused warm, three bands."

```
  client (React 19) ──HTTP──► server (Node 20) ──HTTP──► providers
  NDJSON reader              Next.js handler              Anthropic
                             ALS + spacing gate           Bloomreach MCP
```

**Q: What's the longest-lived in-memory thing, and what's the shortest?**

Longest: the module-scope `Map<sessionId, SessionFeed>` at `lib/state/insights.ts:14`. It lives as long as the warm Node instance — minutes to hours under traffic, zero after idle scale-down.

Shortest: the per-call `AbortSignal.timeout(30_000)` in `lib/mcp/transport.ts:131`. It lives for one MCP round-trip, ≤30s. It's torn down the moment the call resolves or rejects.

The interesting middle is the `AsyncLocalStorage` frame — per-request lifetime, but it's the only thing that lets concurrent requests share module-scope storage without clobbering each other's auth state.

```
  process ──── module Maps ──── ALS frame ──── per-call timer
   hours          hours           seconds         30s max
                                  ↑
                          this is the bridge
```

## See also

  → `02-processes-threads-and-tasks.md` for why Node being single-threaded matters here.
  → `04-shared-state-races-and-synchronization.md` for the ALS-vs-module-scope mechanics.
  → `07-backpressure-bounded-work-and-cancellation.md` for the per-call ceiling and the cancellation propagation.
  → `study-system-design/01-request-flow.md` for the topology view of the same map.

# Memory, stack, heap, GC, and lifetimes

*Memory model · Language-agnostic (with JS/V8 specifics)*

## Zoom out — where this concept lives

Memory in this codebase is a story about *lifetimes*. Node's garbage collector handles the mechanics; the app's job is to hold references only for the right duration and let go on time. On a warm serverless instance, holding a reference too long is the shape of a leak.

```
Zoom out — memory lifetimes on the Vercel Node instance

┌─ Process memory (V8 heap, one per instance) ──────────────────────┐
│                                                                    │
│  MODULE-SCOPE lifetime (dies only when the process dies)          │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ prompt strings          readFileSync at module top          │  │
│  │ pricing table           lib/agents/pricing.ts               │  │
│  │ compiled schemas        lib/mcp/schema.ts                   │  │
│  │ regex patterns          lib/mcp/transport.ts:55-61          │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  PROCESS-SCOPE STATE (accumulates until GC frees or process dies) │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Map<sessionId, SessionFeed>    ← GROWS with active sessions │  │
│  │ Map<insightId, AgentEvent[]>   ← GROWS with cached invs     │  │
│  │ BloomreachDataSource cache     ← 60s TTL, self-expiring     │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  REQUEST-SCOPE (freed when request ends + GC picks up)            │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ RequestStore ctx              ← released when fn() resolves │  │
│  │ BudgetTracker                 ← released with investigation │  │
│  │ CapabilityEvent[] (eval)      ← released at test end        │  │
│  │ collected: AgentEvent[]       ← held while stream is open   │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## Structure pass — one axis, three altitudes

Trace *"when does this memory get released?"* across the lifetime layers.

```
"When does this memory get released?" — one question, three answers

┌─ module ────────────────────────────────────┐
│  → NEVER, until the process dies             │
│    → OK for small stable data (prompts,      │
│      regexes, pricing table)                 │
└──────────────────────┬──────────────────────┘
                       ▼
┌─ process (with self-expiring TTL) ──────────┐
│  → when the TTL passes AND the reference is  │
│    dropped                                    │
│    → BloomreachDataSource cache: 60s TTL     │
└──────────────────────┬──────────────────────┘
                       ▼
┌─ request ────────────────────────────────────┐
│  → when the request ends (all closures drop) │
│    → the safe default; nothing accumulates    │
└─────────────────────────────────────────────┘
```

The seam that matters: **module ↔ process.** Module-scope holds tiny stable data forever (fine); process-scope holds request-derived state (dangerous without a cap). Every process-scope `Map` in this codebase either has a TTL or is bounded by session count.

## How it works

### Move 1 — the mental model

You know how JS closures keep variables alive as long as the closure is reachable? That's the whole game. GC frees anything that no closure, no map, no promise chain still references. On a warm serverless instance, "reachable from a module-level Map" means "reachable forever until the process dies." So the risk is stashing request-derived data in a module-level Map that never gets cleared.

```
The two shapes memory can take

  MODULE                          REQUEST-SCOPED
  ──────                          ──────────────

  const REGEX = /foo/g            async function handler() {
  const PRICING = {…}               const local = new Map()
  const state = new Map()           await work()
    ▲                               // local drops when handler
    │                               // returns — GC frees it
    │ REACHABLE FOREVER              }
    │ from the module               ▲
    │                               │ reachable only during the request
```

The codebase pattern is: **stable data goes in module scope, request-derived data goes in request-scoped closures OR in module-level Maps with an explicit cleanup contract.**

### Move 2 — the mechanisms

#### Module-scope: small, stable, one-shot

The module-scope allocations in this codebase are small and never grow:

```
Module-scope allocations, categorized

  PROMPTS          ~1-10 KB each, 4 files       legacy agents only
  PRICING TABLE    ~2 KB                        lib/agents/pricing.ts
  REGEX PATTERNS   ~200 bytes each              lib/mcp/transport.ts:55-61
  ENV LOOKUP       primitive strings            various process.env reads

  Total footprint: well under 100 KB
  Growth over time: zero (all one-shot at module load)
```

Nothing in this list has a growth rate; they're all one-shot allocations at module load. Even on the busiest Vercel instance, module-scope memory stays flat.

Real example — the token-redaction regex patterns:

```ts
// lib/mcp/transport.ts:55-61
const TOKEN_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/g,
  /"access_token"\s*:\s*"[^"]+"/g,
  /"refresh_token"\s*:\s*"[^"]+"/g,
  /"id_token"\s*:\s*"[^"]+"/g,
  /"code_verifier"\s*:\s*"[^"]+"/g,
];
```

Five compiled regex objects, allocated once per process. Every subsequent `redactSecrets()` call reuses them — no re-compilation, no per-call allocation.

#### Process-scope with TTL: the DataSource cache

```
The 60s cache — self-expiring, bounded-in-expectation

// lib/data-source/bloomreach-data-source.ts:122
private cache = new Map<string, { result: unknown; expiresAt: number }>();

// on set (line 186):
this.cache.set(cacheKey, { result, expiresAt: now + ttl });

// on read (lines 147-152):
if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result, durationMs: 0, fromCache: true };
  }
}
```

The subtle detail: **entries are never explicitly deleted.** Expired entries stay in the Map until they're overwritten by a new set with the same key, or the Map itself is dropped. On a busy instance with varied queries, the Map grows over the DataSource's lifetime.

Why this is OK here: `BloomreachDataSource` is constructed per request (`makeDataSource()` in `lib/data-source/index.ts`), then dropped at request end. The cache dies with it. There is no long-lived DataSource holding an unbounded expired-entry accumulation.

If a future refactor moved the DataSource to module scope (for warm-instance connection reuse), this cache would leak — the codebase would need an explicit eviction pass.

#### Process-scope without TTL: session Maps

```
Session Maps — grows with active sessions, never explicitly evicted

// lib/state/insights.ts:14
const state = new Map<string, SessionFeed>();     // ★ NEVER cleared by request code

// lib/state/investigations.ts:11
const mem = new Map<string, AgentEvent[]>();      // ★ NEVER cleared by request code
```

The isolation contract is *"only clear this session's sub-map, never the outer map"* (see `04-shared-state-races-and-synchronization.md`). That contract is what keeps concurrent sessions from stepping on each other — but it's also what makes the Map's growth unbounded in principle: every unique session id that ever hits the instance leaves a `SessionFeed` behind.

In practice:
  → Session ids are UUIDv4 (`lib/mcp/session.ts:20`) — 128 bits of entropy, no reuse.
  → Vercel warm instances live at most a few minutes to a few hours before recycling.
  → Session cookies expire after 10 days but Vercel kills the instance long before then.

So the practical footprint on any one instance is *"sessions active in the last few minutes,"* not *"all sessions ever."* Not a leak, but not defended by code either — it's defended by the platform's instance lifetime.

The `_clear(sessionId?)` test hook at `lib/state/insights.ts:95-101` is the only explicit eviction path, and it's test-only.

#### Request-scope: the safe default

Anything created inside a route handler (or inside a `withAuthCookies(fn)` closure) drops when the handler returns:

```
Request-scope allocations that go away for free

  RequestStore ctx           declared in withAuthCookies      auth.ts:90
  BudgetTracker              new BudgetTracker(...) in load    load.eval.ts:265
                             route wiring for prod TBD
  BloomreachDataSource       makeDataSource(mode, sid)         routes
  collected: AgentEvent[]    inside stream closure             route.ts:186
  encoder: TextEncoder       inside stream closure             route.ts:183
  phases: Array<{phase,…}>   inside stream closure             route.ts:216
```

`collected` is the biggest allocation in the request lifetime — it holds every AgentEvent emitted during the investigation. For a typical run that's ~50 events × ~1KB truncated payload ≈ 50KB. Held until the stream closes; released when the handler function's closures unlink.

This is the codebase's default pattern and it's the right one: local allocations, released when the handler returns, GC handles the rest.

#### Investigation-scope: `BudgetTracker` + `CapabilityEvent[]`

Two accumulators live for the length of one investigation:

```
BudgetTracker fields — three small numbers, growing linearly

// lib/agents/budget.ts:42-44
private inputTokens = 0;
private outputTokens = 0;
private turns = 0;
```

Three primitives, updated ~10 times per investigation. Negligible footprint.

```
CapabilityEvent[] — growing array, capped by turns × ~2 events/turn

// eval/load.eval.ts:269, :281
const diagnosisTrace: CapabilityEvent[] = [];
const recommendationTrace: CapabilityEvent[] = [];

// aptkit-adapters.ts:161 (per capability event):
this.hooks.onCapabilityEvent?.(event);
```

Bounded by turns: a diagnostic run is typically 5–15 turns, each emitting a few events. Array of ~20-60 objects, each ~1KB. Released at test end.

### Move 3 — the principle

**Where you allocate is where you live.** Every allocation in this codebase lives exactly as long as its enclosing scope. Module-scope means forever; process-scope Map means "until you delete the key or the instance dies"; request closure means "until the handler returns." The bug shape to avoid is *"request-derived value stashed in a module-scope container that has no eviction policy."*

The codebase's discipline: for anything derived from a request, either **give it a request-scoped closure** (default), or **key it by session with an explicit-clear-only-your-own contract** (session Maps), or **give it a TTL** (DataSource cache). Never module-scope unless the value is stable across all requests.

## Primary diagram — memory by lifetime

```
Memory allocations across scopes

MODULE SCOPE — flat, small, forever
┌──────────────────────────────────────────────────────────────┐
│  prompts, regexes, pricing table                              │
│  ~< 100 KB total, zero growth                                │
└──────────────────────────────────────────────────────────────┘

PROCESS SCOPE (with TTL) — self-expiring
┌──────────────────────────────────────────────────────────────┐
│  DataSource cache (60s TTL)                                   │
│  · one instance per request, dies with the DataSource         │
│  · if DataSource ever became long-lived → expired entries     │
│    would need an eviction pass                                │
└──────────────────────────────────────────────────────────────┘

PROCESS SCOPE (session-keyed) — grows with active sessions
┌──────────────────────────────────────────────────────────────┐
│  Map<sessionId, SessionFeed>                                  │
│  Map<insightId, AgentEvent[]>                                 │
│  · bounded in practice by Vercel instance lifetime            │
│  · NOT bounded by explicit eviction in code                   │
│  · session ids are UUIDs → no key reuse                       │
└──────────────────────────────────────────────────────────────┘

REQUEST SCOPE — freed at handler end
┌──────────────────────────────────────────────────────────────┐
│  ALS RequestStore ctx        withAuthCookies closure          │
│  BloomreachDataSource        per-request construction         │
│  collected: AgentEvent[]     ~50 events × ~1 KB               │
│  encoder, phases[]           local variables                  │
└──────────────────────────────────────────────────────────────┘

INVESTIGATION SCOPE — freed at end of investigation
┌──────────────────────────────────────────────────────────────┐
│  BudgetTracker               three ints + one const           │
│  CapabilityEvent[] (eval)    ~20-60 events × ~1 KB            │
└──────────────────────────────────────────────────────────────┘

CALL SCOPE — freed when the promise settles
┌──────────────────────────────────────────────────────────────┐
│  AbortSignal + timeout       transient primitive              │
│  temporary strings           tool args, results (truncated)   │
└──────────────────────────────────────────────────────────────┘
```

## Elaborate — why the codebase never tunes GC

V8's garbage collector is generational — young allocations that die fast (request closures) get collected cheaply; long-lived objects (module state) get promoted to old space and collected less often. This model happens to fit this codebase perfectly: request-scoped allocations are exactly the "die young" shape V8 optimises for.

The codebase doesn't set `--max-old-space-size`, doesn't call `global.gc`, doesn't ship a heap-dump utility. It doesn't need to. Vercel's Node runtime gives ~1 GB per instance by default; typical steady-state usage is orders of magnitude smaller (session Maps + DataSource caches + module strings). The instance recycles before old-space fills.

If the codebase grew a shape that broke this — say, a background job that accumulates large intermediate results between requests, or a WebSocket connection that holds long-lived per-connection buffers — GC tuning would matter. Neither exists.

The one gotcha: if `BloomreachDataSource` becomes a warm-instance singleton (a reasonable perf optimization), the 60s TTL cache would need eviction because expired-but-not-overwritten entries pile up forever. The fix would be either a periodic `for (const [k, v] of cache) if (v.expiresAt < now) cache.delete(k)` sweep or a size cap.

## Interview defense

**Q: Show me a module-scope Map in this codebase. Why isn't it a leak?**

`const state = new Map<string, SessionFeed>()` at `lib/state/insights.ts:14`. It grows with every unique session id that hits this instance. It's not a leak because:

  1. Session ids are UUIDv4 (never reused).
  2. Vercel warm instances live at most a few minutes to a few hours, then recycle. The Map dies with the instance.
  3. On any live instance, "sessions active in the last few minutes" is the practical bound.

It IS unbounded in principle — no explicit eviction, no LRU. If Vercel changed to hour-long warm instances and traffic spiked, we'd want an eviction pass. Today, instance lifetime is the defense.

Anchor: `lib/state/insights.ts:14` (the map), `:8-12` (the isolation comment), `lib/mcp/session.ts:20` (UUID generation).

**Q: The DataSource has a 60s cache. Show me where an entry gets removed.**

Nowhere explicitly. Look at `lib/data-source/bloomreach-data-source.ts:186` — entries get set. There's no `.delete()` on the cache. Expired entries sit in the Map until either overwritten by a new set with the same `name:JSON.stringify(args)` key, or the whole Map is dropped when the DataSource is dropped.

This is safe because the DataSource is constructed per request (`makeDataSource()` in each route) and dropped at request end. The cache dies with it.

If we moved to a warm-instance DataSource singleton (a performance win — avoids re-authing MCP every request), this cache would need eviction. The fix would be a size cap or a sweep pass. Anchor: `lib/data-source/bloomreach-data-source.ts:122, :186`.

**Q: What's the largest single allocation in a live request?**

The `collected: AgentEvent[]` array inside the /api/agent stream closure at `app/api/agent/route.ts:186`. It holds every event emitted during an investigation — reasoning steps, tool calls, tool results (truncated to 4KB via `TRUNC = 4000`), the diagnosis, the recommendations, the `done` event. Typical: ~50 events × ~1 KB = ~50 KB. Held until the stream closes; then GC'd.

The truncation is the load-bearing detail — without it, a multi-MB EQL response would pin memory for the request duration. Anchor: `app/api/agent/route.ts:97-101`.

## See also

  → `01-runtime-map.md` — the scope diagram this file elaborates on.
  → `04-shared-state-races-and-synchronization.md` — why the module-scope Maps are session-keyed.
  → `06-filesystem-streams-and-resource-lifecycle.md` — the `TextEncoder` allocations and the truncation pattern.

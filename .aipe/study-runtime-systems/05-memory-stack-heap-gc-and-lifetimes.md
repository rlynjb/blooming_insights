# Memory, stack, heap, GC, and lifetimes

**Industry name:** V8 heap · generational GC · closure retention · response cache · **Type:** Language-specific (Node/V8)

## Zoom out, then zoom in

Memory in this app is **boring on purpose** — no big objects pinned forever, no streaming caches that grow unbounded, no allocations in the hot loop. The only retained-across-requests things are a handful of `Map`s and the closures inside them. V8's default GC does the rest.

```
  Zoom out — where memory lives

  ┌─ band 1: client ─────────────────────────────────────┐
  │  React state, NDJSON buffer (one TextDecoder, one    │
  │  string buf rotated per chunk)                       │
  └────────────────────────┬─────────────────────────────┘
                           │
  ┌─ band 2: Node V8 heap ★ THIS FILE ★ ────────────────┐
  │                                                       │
  │  young gen → old gen → large object space            │
  │                                                       │
  │  long-lived:                                          │
  │   ─ module-scope Maps (Session feeds, investigations) │
  │   ─ BloomreachDataSource.cache (60s TTL entries)      │
  │   ─ ALS instance (one per process)                    │
  │                                                       │
  │  short-lived:                                         │
  │   ─ per-request ctx, signals, Promises                │
  │   ─ JSON.parse'd payloads (drop after handler exits)  │
  │   ─ TextEncoder, ReadableStream chunks                │
  └──────────────────────────────────────────────────────┘
```

Zoom in. The interesting question is **what gets retained accidentally** — closures captured by long-lived things that pin objects that should have been short-lived. The repo has one such retention path worth understanding (the 60s response cache) and one that's intentionally bounded (`putInsights` `.clear()` semantics).

## Structure pass

**Axis: lifetime — how long does the bytes live in the heap?**

```
  Heap residents by lifetime

  ┌─ old generation (survived ≥2 minor GCs) ─────────────────┐
  │  module-scope Maps                                        │  → process lifetime
  │  ALS root, OAuth provider singletons                      │     (warm instance)
  └─────────────────────┬────────────────────────────────────┘
                        │  seam: bytes only get here by
                        │        surviving young gen
  ┌─ young generation ─▼─────────────────────────────────────┐
  │  per-request request frames                               │  → typically seconds
  │  fetch responses, JSON.parse'd objects                    │     (cleared by GC)
  │  ReadableStream chunks during streaming                   │
  └─────────────────────┬────────────────────────────────────┘
                        │  seam: short-lived burst, dies fast
  ┌─ stack (call frame) ▼────────────────────────────────────┐
  │  current sync execution frame                             │  → microseconds
  │  local primitives (numbers, booleans)                     │
  └──────────────────────────────────────────────────────────┘
```

**Seam: what makes a young-gen object end up in old gen?** Being referenced by an old-gen object. So when a long-lived `Map` retains a closure that captures a request-scoped payload, that payload's lifetime promotes from "seconds" to "process lifetime." This is the most common heap-retention bug in async Node code, and the 60s response cache is exactly where to look for it.

## How it works

### Move 1 — the mental model

Think of V8's heap like a fast lane (young generation) and a slow lane (old generation). New objects are allocated in the fast lane; if they survive two minor GCs, they get promoted to the slow lane. The fast lane is collected often (cheap); the slow lane is collected rarely (expensive).

The retention question is: **does anything in the slow lane hold a reference to something that should have died in the fast lane?** If yes, you have a leak — slow growth across requests until the instance OOMs (or, in serverless, until Vercel reaps it).

```
  Pattern — the retention graph that matters

  ┌─ module scope (old gen) ──────────────────────────────────┐
  │  state ──► Map { sid_A → SessionFeed, sid_B → ... }       │
  │             ▲                                              │
  │             │ Insight objects reachable from here          │
  │             │ are RETAINED for as long as the sub-map      │
  │             │ retains them.                                │
  │                                                            │
  │  cache ──► Map { 'tool:args' → { result, expiresAt } }    │
  │             ▲                                              │
  │             │ JSON-parsed results pinned for 60s           │
  │             │ (or until next .set() overwrites)            │
  └────────────────────────────────────────────────────────────┘
                       ▲
                       │ does anything in here
                       │ accidentally keep a per-request
                       │ payload alive past 60s?
```

### Move 2 — the moving parts

#### Move 2.1 — the module-scope Maps

`lib/state/insights.ts:14`: `const state = new Map<string, SessionFeed>()`. Module-scope = old generation. Every value reachable from this Map is pinned.

A `SessionFeed` contains three sub-Maps:

```ts
// lib/state/insights.ts:8-12
type SessionFeed = {
  insights: Map<string, Insight>;
  investigations: Map<string, Investigation>;
  anomalies: Map<string, Anomaly>;
};
```

The `Insight` objects are JSON-serializable data (no closures, no DOM refs), so they retain only their own bytes — modest. An average `Insight` is maybe 1–4 KB.

**Bounded by `.clear()`.** Every fresh `putInsights(sid, items)` call (`lib/state/insights.ts:64-71`) does `s.insights.clear(); s.anomalies.clear();` before re-setting, so the per-session sub-maps cannot grow past one briefing's worth. The comment at lines 58-63 spells this out: *"each run IS the current feed, not an addition. Without clearing, a warm serverless instance accumulates stale insights from earlier runs."*

**The outer Map keeps growing across sessions.** A session that visited once and never came back leaves a `SessionFeed` pinned forever (or until the warm instance dies). With infinite users you'd OOM. With Vercel's instance lifetime measured in hours, the GC pressure is bounded by "active sessions per hour." No eviction policy.

```
  Lifetime trace — session feed retention

  t=0           Vercel cold start
  t=0           state = new Map()
  t=12s         sid_A briefing → state.set(sid_A, SessionFeed)
  t=25s         sid_B briefing → state.set(sid_B, SessionFeed)
  t=120s        sid_A second briefing → s.insights.clear() then .set()
                (sid_A's inner Maps stable size; outer Map untouched)
  t=10min       sid_C briefing → outer Map = 3 entries
  ...
  t=2hr         no new traffic → Vercel scales to zero
                process dies, ALL Maps go
```

#### Move 2.2 — the 60s response cache

`lib/data-source/bloomreach-data-source.ts:122`: `private cache = new Map<string, { result: unknown; expiresAt: number }>()`. **Per-instance**, because `BloomreachDataSource` is constructed inside the request (`lib/mcp/connect.ts:96`). Wait — is it per-request or per-process? Let me trace it.

Looking at `connectMcp` (`lib/mcp/connect.ts`): it returns a fresh `BloomreachDataSource` per call. Each request that goes live-mode constructs its own. So the response cache is **per-request**, not per-process. It dies when the handler's closures die (after the response is fully written).

That means the cache primarily absorbs repeats *within one request*: the bootstrap chain does `list_cloud_organizations → list_projects → get_event_schema` and any tool that's called twice in one investigation hits the cache. It does NOT absorb repeats across two different `/api/agent` requests for the same insight — those each get their own DataSource and their own cache.

```
  Cache scope — per-request, not per-process

  request A (live) ──► new BloomreachDataSource()
                         └─ private cache: Map()
                         └─ private lastCallAt: 0
  request A: callTool('list_cloud_organizations', {})
   ─ MISS, fetch from server, cache for 60s
  request A: callTool('list_cloud_organizations', {})  ← bootstrap retry
   ─ HIT (in-request)

  request B (live) ──► new BloomreachDataSource()  (different instance)
                         └─ private cache: Map()  (fresh, empty!)
                         └─ private lastCallAt: 0
  request B: callTool('list_cloud_organizations', {})
   ─ MISS, fetch from server  (no benefit from A's cache)
```

**This is a deliberate-but-arguably-suboptimal call.** A process-scoped cache would absorb cross-request repeats on the same warm instance. The current shape doesn't — the comment at `bloomreach-data-source.ts:8` describes the cache as "60s response cache that absorbs repeats" without specifying scope, but the per-instance construction in `connectMcp` is what makes it per-request.

If you wanted process-scoped: lift the `cache` Map to module scope, key it by `sessionId:tool:args` instead of just `tool:args`. Same partition discipline as the session feeds.

#### Move 2.3 — closures and what they pin

Every `setTimeout`, `Promise`, `AbortSignal.timeout` is a closure that captures variables from its lexical scope. If a long-lived structure holds a reference to one of those closures, the closure pins everything it captured.

Concrete example — the spacing-gate Promise:

```ts
// lib/data-source/bloomreach-data-source.ts:193
await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
```

This Promise captures `r` (the resolve function); the `setTimeout` captures `r` too. Once `setTimeout` fires, both are released, the Promise resolves, the await continues, and everything captured goes out of scope. Lifetime: ≤1.1s. No leak.

Counterexample — what would leak:

```ts
// HYPOTHETICAL — not in the repo
const pendingByTool: Record<string, Promise<unknown>> = {};
pendingByTool[name] = transport.callTool(name, args);  // never cleared
```

That `pendingByTool` (module scope) would retain every Promise ever started, each pinning its closures, each pinning the args it captured. Slow leak, hard to spot, eventual OOM. The codebase avoids this — every Promise it creates is awaited and discarded in the same scope.

#### Move 2.4 — the NDJSON buffer

Client side: `lib/streaming/ndjson.ts:30` declares `let buf = ''` outside the read loop. Each chunk appends, then the buffer is split on `\n` and the trailing fragment kept:

```ts
buf += decoder.decode(value, { stream: true });
const lines = buf.split('\n');
buf = lines.pop() ?? '';
```

The buffer holds at most one partial line at a time. NDJSON producers terminate each event with `\n`, so the trailing partial is typically empty or a few bytes. Lifetime: as long as the read loop runs (one investigation, ≤300s server-side, then `releaseLock()` and out). No accumulation across requests.

#### Move 2.5 — what does NOT exist (the easy wins for ruling out leaks)

  → No long-lived `setInterval` keeping a closure alive forever.
  → No global event emitters with `.on()` listeners that accumulate per-request handlers.
  → No `WeakMap`/`WeakSet` usage (the codebase doesn't need them because there are no DOM-ref-style "remove when X is collected" patterns).
  → No `Buffer` slicing that could pin parent buffers (`Buffer.slice` shares memory; only relevant if you slice and retain — the codebase doesn't).
  → No streaming JSON parser holding a partial parse forever — everything goes through the chunk-at-a-time NDJSON loop above.

### Move 3 — the principle

In a long-lived server process, **the heap is what your module-scope variables transitively reference, plus whatever's live in the current request stack.** The bug is always "something module-scope accidentally retained a request-scope object." The defense is always "name your module-scope variables, audit their retention chains, partition or evict when growth is unbounded." This codebase does the first two well; the third (eviction on the outer `state` Map) is "not yet exercised" — bounded by Vercel's instance lifetime today.

## Primary diagram

```
  Heap residents by lifetime — every retained thing, every retention edge

  ┌─ V8 old generation (per Node process) ───────────────────────────┐
  │                                                                   │
  │  state ──► Map<sid, SessionFeed>                                  │
  │             │                                                     │
  │             ├─ sid_A → { insights, investigations, anomalies }    │
  │             │            (each .clear()ed per fresh briefing)     │
  │             ├─ sid_B → ...                                        │
  │             └─ sid_C → ...                                        │
  │                                                                   │
  │  mem ────► Map<insightId, AgentEvent[]>                           │
  │             (per-instance investigation cache)                    │
  │                                                                   │
  │  memStore ─► Map<sid, SessionAuthState>  (test backend only)      │
  │                                                                   │
  │  requestStore ─► AsyncLocalStorage instance (root)                │
  │                                                                   │
  │  module imports: Next.js, @anthropic-ai/sdk, @modelcontextprotocol│
  │  /sdk, encoding tables, code, ...                                 │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ V8 young generation (per request, mostly) ──────────────────────┐
  │                                                                   │
  │  per-request BloomreachDataSource                                 │
  │   └─ cache: Map (≤60s entries) — dies with the DataSource         │
  │   └─ lastCallAt: number                                           │
  │                                                                   │
  │  ALS frame ctx = {store, dirty}                                   │
  │  req.signal AbortSignal                                           │
  │  ReadableStream controller, encoder, collected[] array            │
  │  fetch response Promises, JSON.parse'd payloads                   │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

V8's generational GC has been the default in Node since the beginning. Most allocations are short-lived — the "infant mortality" hypothesis — so collecting young gen frequently is cheap. The cost you pay: long-lived objects that *should have died* and got promoted to old gen are expensive to find later. That's why "leak" in Node usually means "module-scope reference you forgot about," not "missing free()."

The default V8 heap is around 1.7 GB on 64-bit. Vercel's Pro plan gives Node functions configurable memory (the default is enough here). A `--max-old-space-size` override is not in the repo and would only be needed if heap growth crossed that line — at this codebase's shape, nowhere close.

Worth reading: the V8 "fast properties" / "hidden classes" docs for why `new Map()` outperforms `{}` for dynamic keys; *High Performance Browser Networking* on browser GC (the client-side NDJSON loop's `buf` rotation is the same shape); Node's `--inspect` heap-snapshot workflow for chasing retention paths in production.

## Interview defense

**Q: What in this codebase could leak memory?**

The honest answer: very little, by construction. Two candidates worth inspecting:

  1. The outer `state` Map at `lib/state/insights.ts:14`. It grows monotonically as new sessions appear, no eviction. With infinite distinct sessions across one warm instance's lifetime, you'd OOM. With Vercel reaping idle instances every few hours, in practice it's bounded by "active sessions per few-hour window." Not a leak in the strict sense; an unbounded retention with a platform-level reaper.

  2. Closures captured by long-lived structures. The codebase doesn't have any module-scope structures retaining Promises or callbacks — the only long-lived Maps store JSON-shaped data, not closures. So nothing pins per-request scope past the response.

If I were tightening this: add an LRU on the outer `state` Map keyed by last-touch timestamp. Today it's not earning its keep — instance lifetime handles it.

```
  the audit:  for every module-scope variable, ask
              "does this retain anything per-request?"
              → no, for every variable in this repo today
```

**Q: What's the lifetime of the BloomreachDataSource's 60s response cache?**

Per-request. The DataSource is constructed inside `connectMcp` per call (`lib/mcp/connect.ts:96`), so each request gets its own instance with its own fresh cache. The 60s TTL governs entries *within* that request — it absorbs the bootstrap chain (`list_cloud_organizations → list_projects → get_event_schema → ...`) calling repeated tools.

It does NOT cache across requests. A second `/api/agent` call for the same insight on the same instance re-fetches everything. A process-scoped cache would absorb that — the comment in `lib/data-source/index.ts:14-18` describes why the Bloomreach adapter is session-scoped today and what would change if we lifted the cache to module scope.

Anchor: "60s TTL, per-DataSource-instance, per-request — the bootstrap retry is the typical hit."

```
  request 1: new DataSource → fresh cache → 6 tool calls → cache holds 6 entries
  request 1 ends: DataSource closures GC'd → cache GC'd
  request 2: new DataSource → fresh cache → re-fetches the same tools
```

## See also

  → `01-runtime-map.md` for where these heap regions sit relative to process lifetime.
  → `04-shared-state-races-and-synchronization.md` for the partition discipline that makes the outer Map safe.
  → `06-filesystem-streams-and-resource-lifecycle.md` for non-heap resources (file handles, stream controllers).

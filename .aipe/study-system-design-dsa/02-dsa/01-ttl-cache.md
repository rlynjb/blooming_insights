# TTL cache

**Industry name(s):** cache-aside (lazy caching) with time-to-live expiry, memoization with invalidation
**Type:** Industry standard · Language-agnostic

> A Map-backed lookup table where each entry carries an absolute expiry timestamp; reads return the stored value when it is still fresh and fall through to the live source when it is stale or absent.

**See also:** → 02-rate-limit-and-retry.md · → ../01-system-design/04-caching-and-rate-limiting.md

---

## Why care

You memoize fetch results in a `Map` so repeat queries are instant — but stale data lingers forever. There is no mechanism to expire entries. A component that calls the same endpoint again after ten minutes gets the same ten-minute-old payload, silently. The question is: how does a lazy cache expire entries by time without a background sweep?

That is what a TTL cache answers: every write records `expiresAt = Date.now() + ttl`; every read checks `expiresAt > Date.now()` and serves the entry only when that is true.

**The stakes are concrete.** An MCP tool call takes 1.1 s or more when the rate limiter kicks in. Caching identical `(name, args)` pairs for 60 s turns repeat queries into ~0 ms. But you must never cache an error result — if a 429 is stored, every caller for the next 60 s gets that poisoned response without any chance for the server to recover.

One-line reduction: a TTL cache is a `Map` where the value is `{result, expiresAt}` and a read is only valid while `expiresAt > Date.now()`.

---

## How it works

### Mental model

Every entry in the Map is a pair: a result and a deadline. A read is a cache hit only when the entry exists **and** the deadline is still in the future. Everything else — missing entry, expired entry — falls through to the live call, which then writes a fresh entry with a new deadline.

```
callTool(name, args)
        │
        ▼
  build cacheKey
        │
        ▼
  ┌─────────────────────────────────┐
  │  cache.get(cacheKey)            │
  │                                 │
  │  entry exists?  ──No──►  miss  │
  │       │                   │    │
  │      Yes                  │    │
  │       │                   │    │
  │  expiresAt > now?          │    │
  │       │                   │    │
  │      Yes         No──►  miss  │
  │       │                   │    │
  │    HIT ◄──────────────────┘    │
  └─────────────────────────────────┘
        │                   │
     return               live call
   {result,                  │
    fromCache:true,      isError?
    durationMs:0}             │
                       Yes       No
                        │         │
                     return    write entry
                    (no write)  {result,
                                 expiresAt:
                                  now+ttl}
                                    │
                                 return
                               {result,
                                fromCache:false,
                                durationMs}
```

The diagram captures the full decision tree. Every path that does not produce a hit ends at a live call, and every live call that does not produce an error writes a new cache entry.

---

### Isolate the kernel

A TTL cache has an irreducible kernel: four parts that *are* the pattern. Strip anything else and you still have a working cache. Strip any of these and you don't.

```
callTool(name, args):
  key       = name + ':' + JSON.stringify(args)      ─┐
  entry     = map.get(key)                            │
  if entry and entry.expiresAt > Date.now():          │  KERNEL
    return entry.result          ← HIT                │  (the
  result    = liveCall(name, args)                    │   pattern,
  if result is not an error:                          │   minus
    map.set(key, {result, expiresAt: now + ttl})      │   nothing)
  return result                  ← MISS, then FILL   ─┘
```

Four load-bearing pieces: the key construction, the expiry check, the no-error-write guard, and the post-call fill. No size cap, no LRU, no `skipCache` override — those are *hardening* layered on top.

---

### Name each part by what breaks when removed

The way the reader learns which parts are load-bearing is by removing each and watching the pattern collapse. None of these is decoration.

```
Removed                          What breaks
──────────────────────────       ─────────────────────────────────────
key = name + JSON.args           Unrelated calls collide on the same
                                 slot. callTool("search",{q:"react"})
                                 returns the result of {q:"vue"} —
                                 the cache becomes a corrupter.

expiresAt > Date.now() check     Stale results serve forever. The
                                 cache becomes a permanent freeze
                                 instead of a refreshable layer.

isError guard before write       A 429 or a tool failure POISONS the
                                 slot for the full TTL. Every caller
                                 reads the error; no retry reaches
                                 the server until expiry.

post-call map.set on success     The map exists but never fills.
                                 Every call is a miss. You have the
                                 data structure but not the cache.
```

This is the difference between a reader who memorised "TTL cache has four parts" and one who knows *which four parts*. The first reader can list them. The second can defend the design by naming the bug each one prevents.

---

### Separate skeleton from optional hardening

The kernel above is the minimum. Everything around it is hardening — useful, but layered on. Saying which is which is part of the pattern.

```
SKELETON (in McpClient — required)        HARDENING (some present, some not)
────────────────────────────────────      ──────────────────────────────────
key = name + ':' + JSON.stringify(args)   ┌ LRU / size cap          (absent)
expiry check on read                      ├ key normalization       (absent)
isError guard before write                ├ shared store (Redis)    (absent)
fill on miss                              ├ stale-while-revalidate  (absent)
                                          └ skipCache override      (present)
```

`McpClient` ships the four kernel pieces plus exactly one piece of optional hardening — `skipCache`. It omits LRU (so unbounded growth is real), key normalization (so `{a,b}` and `{b,a}` collide as different keys), a shared store (per-instance, so a cold start re-bootstraps), and stale-while-revalidate (so a miss blocks on the live call). The breakpoint that flips any of those choices lives in Tradeoffs.

---

### Step-by-step execution trace

Scenario: the same tool is called twice within the TTL window, then again after expiry, then fails.

Assume `ttl = 60_000` ms and the cache starts empty. Timestamps are illustrative integers in ms.

```
Step │ Action                        │ cacheKey          │ cached          │ expiresAt  │ Date.now() │ fromCache │ cache contents after step
─────┼───────────────────────────────┼───────────────────┼─────────────────┼────────────┼────────────┼───────────┼──────────────────────────────────────
1    │ call A ("search",{q:"react"}) │ search:{"q":"react"}│ undefined      │ —          │ 1000       │ false     │ search:{"q":"react"} → {r:R1, exp:61000}
     │ → miss → live → success R1   │                   │                 │            │            │           │
─────┼───────────────────────────────┼───────────────────┼─────────────────┼────────────┼────────────┼───────────┼──────────────────────────────────────
2    │ call A again                  │ search:{"q":"react"}│ {r:R1,exp:61000}│ 61000     │ 5000       │ true      │ unchanged
     │ → hit (61000 > 5000)          │                   │                 │            │            │           │
─────┼───────────────────────────────┼───────────────────┼─────────────────┼────────────┼────────────┼───────────┼──────────────────────────────────────
3    │ 65 s pass; call A again       │ search:{"q":"react"}│ {r:R1,exp:61000}│ 61000     │ 66000      │ false     │ search:{"q":"react"} → {r:R2, exp:126000}
     │ → miss (61000 < 66000)        │                   │                 │            │            │           │
     │ → live → success R2          │                   │                 │            │            │           │
─────┼───────────────────────────────┼───────────────────┼─────────────────┼────────────┼────────────┼───────────┼──────────────────────────────────────
4    │ call A; live returns error E  │ search:{"q":"react"}│ {r:R2,exp:126000}│ 126000  │ 70000      │ true      │ unchanged (error not written)
     │ → would be hit but...         │                   │                 │            │            │           │
     │ actually: 126000 > 70000 → hit│                   │                 │            │            │           │
─────┼───────────────────────────────┼───────────────────┼─────────────────┼────────────┼────────────┼───────────┼──────────────────────────────────────
4b   │ call A with skipCache:true;   │ search:{"q":"react"}│ (skipped)      │ —          │ 70000      │ false     │ unchanged (isError=true → no write)
     │ live returns error E          │                   │                 │            │            │           │
```

Step 4b shows the guard: `skipCache` bypasses the read, the live call returns an error (`isError:true`), and the cache is not updated. The previous good entry `R2` survives in the Map.

The principle: cache reads, never errors; expiry is the simplest invalidation strategy.

---

## TTL cache — diagram

Primary recap of the full `callTool` path through the cache layer.

```
callTool(name, args)
        │
        ▼
  cacheKey = name + ':' + JSON.stringify(args)
  ttl      = options.cacheTtlMs ?? 60_000
        │
        ├── skipCache? ──Yes──────────────────────────────────────►┐
        │                                                           │
        No                                                          │
        │                                                           │
        ▼                                                           │
  ┌─────────────────────────────────────────────────────────────┐  │
  │  McpClient.cache  (Map<string,{result,expiresAt}>)          │  │
  │                                                             │  │
  │  "search:{"q":"react"}"  →  {result: R1, expiresAt: 61000} │  │
  │  "search:{"q":"vue"}"    →  {result: R2, expiresAt: 61000} │  │
  └─────────────────────────────────────────────────────────────┘  │
        │                                                           │
  cache.get(cacheKey)                                              │
        │                                                           │
  entry exists AND expiresAt > Date.now()?                         │
        │                                                           │
       Yes                    No                                    │
        │                     │                                     │
        ▼                     ▼◄────────────────────────────────────┘
  return {               liveCall(name, args)
   result,                    │
   durationMs: 0,        retry if rate-limited (up to maxRetries)
   fromCache: true }          │
                         isError === true?
                          │           │
                         Yes          No
                          │           │
                       return     cache.set(cacheKey, {
                      {result,      result,
                       durationMs,  expiresAt: Date.now() + ttl
                       fromCache:   })
                        false}       │
                                  return {
                                    result,
                                    durationMs,
                                    fromCache: false }
```

The Map is the single shared store for the `McpClient` instance. Every `callTool` invocation either reads from it (hit) or writes to it (miss + success), but never writes an error.

---

## In this codebase

**File:** `lib/mcp/client.ts`
**Function / class:** `McpClient.callTool`
**Line range:** L80 (cache field), L102–L110 (cache read), L137–L144 (cache write)

Cache field declaration (L80):

```ts
private cache = new Map<string, { result: unknown; expiresAt: number }>();
```

Cache read — hit path (L102–L110):

```ts
const cacheKey = `${name}:${JSON.stringify(args)}`;
const ttl = options.cacheTtlMs ?? 60_000;

if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

Cache write — success guard (L137–L144):

```ts
if ((result as any)?.isError === true) {
  return { result: result as T, durationMs, fromCache: false };
}

const now = Date.now();
this.cache.set(cacheKey, { result, expiresAt: now + ttl });
return { result: result as T, durationMs, fromCache: false };
```

GitHub: https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/client.ts#L102-L144

---

## Elaborate

### Where it comes from

Cache-aside (also called lazy caching) is the pattern where the application, not the cache layer, is responsible for populating the cache. The cache is not pre-warmed; it fills itself on the first miss. TTL adds a time dimension: entries are valid for a fixed window and then become invisible to readers, forcing a refill on the next access.

React Query implements the same idea: `staleTime` controls how long a fetched result is considered fresh. After `staleTime` elapses, the next mount or focus event triggers a background refetch. The difference is that React Query uses stale-while-revalidate (serve stale, refetch in background); `McpClient` uses hard expiry (serve nothing stale, block on refetch).

### The deeper principle

A cache is a function from key to result. TTL adds a second dimension — time — making the function valid only within a window.

```
f(key, t) = stored_result   if entry(key) exists AND entry(key).expiresAt > t
f(key, t) = live_result     otherwise, and then store live_result with new expiresAt
```

The expiry check is purely arithmetic. No background timer, no event loop polling, no garbage collection pass. The check is paid for only by callers who actually need a value.

```
  timeline ──────────────────────────────────────────────────────►
             write at t=0                         t=60_000
                │                                      │
  expiresAt ────┼──────────────────────────────────────┤  expired
                │  ← reads in this window → hit        │
                │  reads after this point → miss        │
```

### Where it breaks down

Three failure modes are inherent to this design:

**In-memory, per-process.** The `cache` Map lives in the Node.js process heap. A server restart clears it. If the app runs on multiple instances (horizontal scaling), each process has its own Map; there is no shared state. Instance A's cache hit is instance B's cache miss.

**No size bound — unbounded growth.** The Map accumulates an entry for every distinct `(name, args)` pair ever called. Expired entries are not evicted; they stay in memory until the process restarts or the entry is overwritten by a fresh write with the same key. If the set of distinct argument combinations is large, the Map grows without ceiling.

**No cross-instance coherence.** A forced-fresh call via `skipCache` on one process does not invalidate the entry on another process. Two instances can serve contradictory results from the same tool call.

### What to explore next

- **LRU eviction** — a Least Recently Used cache adds a size cap; when the Map would exceed N entries, the entry accessed furthest in the past is evicted. The `lru-cache` npm package implements this. Combine with TTL to bound both size and freshness.
- **Redis as shared cache** — moves the Map to a network-accessible key-value store. All instances share one cache. TTL is a native Redis feature (`SET key value EX 60`). Adds network latency on every cache read.
- **Stale-while-revalidate** — instead of blocking on a miss, serve the stale entry immediately and trigger a background refetch. React Query's default. Trades consistency for perceived speed.

---

## Tradeoffs

| Dimension | This implementation (TTL Map) | LRU + TTL | No cache |
|---|---|---|---|
| Read latency (hit) | O(1), ~0 ms | O(1), ~0 ms | N/A |
| Read latency (miss) | O(1) + live call (~1.1 s+) | O(1) + live call | live call always |
| Write cost | O(1) Map.set | O(1) + LRU bookkeeping | none |
| Space complexity | O(distinct keys), unbounded | O(N) where N = LRU cap | O(1) |
| Error safety | errors not cached | errors not cached | errors never persist |
| Cross-instance sharing | none (per-process) | none (unless Redis) | n/a |
| Staleness window | up to `ttl` ms | up to `ttl` ms | always fresh |
| Invalidation control | time only (no manual eviction) | time + size cap | none needed |

**What was given up.** The Map has no size cap. Every unique `(name, args)` combination adds a permanent entry for the life of the process. In a session with a bounded call space this is fine. In a long-running server with a large argument space it becomes a memory leak.

**Alternative cost.** LRU adds bookkeeping: a doubly-linked list or equivalent structure to track access order. Every read and write touches the list in addition to the Map. The overhead is constant-factor but non-zero. Running with no cache at all pays the full 1.1 s+ rate-limit penalty on every call — every identical repeat is a fresh network round-trip.

**Breakpoint.** The current design is correct for session-scoped use where the number of distinct tool-call argument combinations is small and bounded. It needs LRU (to cap size) or Redis (to share state) when: (a) distinct keys grow large relative to available memory, (b) the app scales horizontally, or (c) cache coherence across deploys is required.

---

## Tech reference (industry pairing)

### JavaScript Map (cache store)

- **Role:** keyed in-memory store; O(1) average get/set; preserves insertion order (unused here).
- **Leader:** native `Map` — no dependency, zero overhead; used directly in `McpClient`.
- **Runner-up:** `lru-cache` (npm) — wraps a Map with a size cap and optional per-entry TTL; drop-in for the `cache` field when unbounded growth becomes a problem.
- **Key API surface:** `map.get(key)`, `map.set(key, value)`, `map.has(key)`, `map.delete(key)`.
- **What it does not do:** no TTL natively, no max-size, no LRU eviction — the application code in `callTool` supplies all of these.

### cache-aside + TTL

- **Role:** the architectural pattern; the application is the cache-population agent, not a middleware layer; TTL is the expiry mechanism.
- **Leader:** React Query — `staleTime` + `cacheTime` implement cache-aside with stale-while-revalidate; the `queryKey` is the cache key equivalent.
- **Runner-up:** SWR (Vercel) — same pattern, `dedupingInterval` is the TTL equivalent for in-flight deduplication.
- **Contrast with cache-through:** in cache-through the cache layer intercepts writes and keeps itself up to date; cache-aside requires the application to write explicitly after a live call succeeds.
- **Industry use:** Redis `SET key value EX 60` is cache-aside + TTL at the network level; the semantics are identical to `cache.set(key, {result, expiresAt: now+60_000})` — only the store and the expiry mechanism differ (server-side timer vs. inline check).

---

## Summary

`McpClient` implements cache-aside with TTL: a `Map<string, {result, expiresAt}>` keyed on `name + ':' + JSON.stringify(args)`. On every `callTool` invocation the code builds the key, checks whether a non-expired entry exists, and returns it immediately if so. On a miss it calls the transport, retries on rate-limit errors, and writes the result to the Map with `expiresAt = Date.now() + ttl` — but only when the result is not an error. The TTL defaults to 60 000 ms. `skipCache` bypasses the read check but still performs a write on success, which intentionally refreshes the entry for all subsequent callers.

- The cache key is a deterministic string; argument order matters because `JSON.stringify` is order-sensitive — `{a:1,b:2}` and `{b:2,a:1}` produce different keys and different cache slots.
- Expiry is checked inline at read time, not via a background timer; expired entries stay in the Map until overwritten.
- Error results (`isError === true`) are never written to the cache; this is the poisoned-cache guard.
- The Map is per-process and per-instance; horizontal scaling means no shared cache state.
- Space complexity is O(distinct keys) with no upper bound; this is the main tradeoff against LRU.
- The pattern is identical to React Query's `staleTime` behaviour, with hard expiry instead of stale-while-revalidate.

---

## Interview defense

**What they are really asking.** When an interviewer asks about this cache they want to know three things: do you understand why errors must not be cached, do you understand the key construction trade-offs, and do you know what happens when the Map grows without bound.

---

**[mid] Why is `expiresAt` an absolute timestamp rather than a duration stored alongside the result?**

A stored duration would be meaningless without also storing the write time, and comparing durations requires subtraction. An absolute timestamp requires only one comparison: `expiresAt > Date.now()`. It is also cheaper to compute at write time (`now + ttl`) than at read time (`writeTime + ttl > now`, which needs both `writeTime` and `ttl` stored). The pattern matches Redis `EXPIREAT` and browser `Date`-based cookie expiry.

```
  write:  expiresAt = Date.now() + ttl
                      └── one addition, stored once

  read:   expiresAt > Date.now()
                      └── one comparison, no stored ttl needed at read time
```

---

**[senior] The key is `name + ':' + JSON.stringify(args)`. What breaks if an argument value contains a colon?**

Nothing breaks. The colon delimiter is between `name` and the JSON string. JSON strings use `"` as delimiters and escape internal characters. A colon inside a string value becomes `":"` in JSON. The only ambiguity would be if `name` itself contained `:{`, which is semantically impossible for a valid tool name — tool names are identifiers. The real risk is argument key ordering: `JSON.stringify({b:1,a:2})` produces `{"b":1,"a":2}`, which is not equal to `{"a":2,"b":1}`. Two callers passing the same logical arguments in different key order get two separate cache entries.

```
caller 1: args = {q:"react", limit:10}   → key ends in {"q":"react","limit":10}
caller 2: args = {limit:10, q:"react"}   → key ends in {"limit":10,"q":"react"}
                                                                │
                                                          different slots
                                                          same live result
                                                          fetched twice
```

Fix: sort argument keys before stringifying. The current implementation does not do this — it is a known trade-off accepted for simplicity in a controlled call context.

---

**[arch] This cache is in-process. What is the minimum change to make it shared across instances?**

Replace the `Map` with a Redis client. The `cache.get` / `cache.set` calls map directly to Redis `GET` / `SET ... EX`. TTL becomes a server-side concern (`SET key value EX 60`) rather than an inline `expiresAt` check. The `isError` guard stays in application code. The key serialization is unchanged.

```
  current                            Redis-backed
  ────────                           ────────────
  Map.get(key)              →        await redis.get(key)   [network]
  Map.set(key,{r,exp})      →        await redis.set(key, JSON.stringify(r), 'EX', ttlSeconds)
  expiresAt > Date.now()    →        (handled by Redis server; key vanishes)
  isError guard             →        unchanged, application layer
```

Trade: per-read network latency (~0.5–2 ms to a local Redis) instead of a Map lookup (~microseconds). Gain: all instances share one store; a `skipCache` write on one process is visible to all.

---

**The dodge: "why no eviction or size cap — won't the Map grow forever?"**

Yes, it will. Every distinct `(name, args)` combination creates a permanent entry for the life of the process. Expired entries are not swept; they occupy memory until they are overwritten by a fresh write with the same key. In a session context with a bounded call space this is acceptable — the number of distinct tool calls a user makes in one session is small. For a long-running server taking arbitrary calls from many users the Map is an unbounded memory sink.

The fix is to replace the native `Map` with an LRU-capped structure (e.g., `lru-cache` with `max: 500`). Every read promotes the entry; when the store is full the least-recently-used entry is evicted regardless of its `expiresAt`. TTL and LRU compose cleanly.

```
  current Map (unbounded)            LRU + TTL (bounded)
  ───────────────────────            ───────────────────
  capacity: ∞                        capacity: N (e.g. 500)
  eviction: never                    eviction: LRU on capacity breach
  expired entries: present           expired entries: present (still checked inline)
  memory growth: O(distinct keys)    memory growth: O(N)
```

---

**Anchors (cite these in your answer)**

- `lib/mcp/client.ts` L80: the `cache` field type.
- `lib/mcp/client.ts` L102–103: key construction and TTL default.
- `lib/mcp/client.ts` L107–108: the expiry check and hit return.
- `lib/mcp/client.ts` L137–139: the `isError` guard that prevents poisoning.
- `lib/mcp/client.ts` L143–144: the write with `expiresAt`.

---

## Validate your understanding

### Level 1 — Reconstruct

Without looking at the code, write the `callTool` cache logic from scratch: build the key, check the entry, return on hit, call live on miss, guard the write. Then compare to `lib/mcp/client.ts` L102–144. Every variable name and comparison operator should match.

### Level 2 — Explain

Walk through what happens when `callTool("search", {q:"react"})` is called three times: at t=0, t=30 s, t=90 s. For each call, state the value of `cacheKey`, whether `cached` is defined, the value of `expiresAt`, the value of `Date.now()`, the result of the comparison, and whether `fromCache` is `true` or `false`. Cite the specific lines in `lib/mcp/client.ts` for each branch taken.

### Level 3 — Apply

**Scenario:** Two callers pass the same logical arguments to `callTool` but in different key order — caller A uses `{q:"react", limit:10}` and caller B uses `{limit:10, q:"react"}`. Do they share one cache entry or produce two? What does `JSON.stringify` produce for each? Now suppose the live call for caller A returns `{isError: true}`. Is any entry written to the cache? What does caller B observe on its next call? Cite `lib/mcp/client.ts` L102 (key construction) and L137–139 (error guard) in your answer.

### Level 4 — Defend

Your tech lead says: "Expired entries stay in the Map forever — this leaks memory. We should run `setInterval` every minute to sweep expired keys." Counter-argue or agree. Consider: how many distinct keys are realistic in a session context, what the sweep costs (iteration over the full Map), and what alternative data structure would solve the problem without a sweep. Reference the `[arch]` interview answer above.

### Quick check

- What is the default TTL in milliseconds, and which line sets it? `lib/mcp/client.ts` L103.
- What does `fromCache: true` imply about `durationMs`?
- Why does `skipCache: true` still perform a cache write?
- Name one scenario where two logically identical calls produce different cache keys.
- What is the space complexity of the current implementation?

---
Updated: 2026-05-28 — refreshed code references to current line numbers
Updated: 2026-05-30 — Applied study.md v1.46 Move-2-variant (load-bearing skeleton: isolate the kernel + what-breaks-if-removed + skeleton vs hardening) to How it works.

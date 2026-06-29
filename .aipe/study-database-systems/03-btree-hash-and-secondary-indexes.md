# B-tree, hash, and secondary indexes — the 60s cache as a hash index

*Industry standard / Project-specific* — there are no persisted indexes; the only index-shaped thing is the 60-second TTL response cache, which is a hash index in disguise.

## Zoom out, then zoom in

A real index does one job: turn an O(N) scan into an O(log N) or O(1) lookup. The only place in this repo that needs that is the path from an agent's tool call back to a tool result during a single briefing — and that path uses a `Map<string, Entry>` keyed by `${name}:${JSON.stringify(args)}`. That's a hash index. It just isn't called one.

```
  Zoom out — where this concept lives

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  StatusLog shows "from cache · 0ms" badges                │
  └────────────────────────────┬─────────────────────────────┘
                               │  HTTP / NDJSON
  ┌─ Service layer ────────────▼─────────────────────────────┐
  │  agent loop calls dataSource.callTool(name, args)         │
  │                          │                                │
  │                          ▼                                │
  │  BloomreachDataSource.callTool                            │
  │    cache.get(key) → ★ THE HASH INDEX LOOKUP ★              │ ← we are here
  │    cache.set(key, { result, expiresAt })                  │
  └────────────────────────────┬─────────────────────────────┘
                               │
  ┌─ Storage layer ────────────▼─────────────────────────────┐
  │  Map<string, { result, expiresAt }>                       │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the index here is a `Map<string, Entry>`. The key is the call signature; the value is the result plus an expiry. There's no B-tree, no LSM, no covering index, no composite key. Just one hash table with TTL eviction.

## Structure pass

**Layers:**

```
  L1  cache: Map<string, Entry>     the hash table
  L2  Entry: { result, expiresAt }  the value
  L3  cache key: string             the hash input
```

**Axis traced: what does a lookup actually cost?**

```
  Trace one axis: cost of a lookup

  ┌─ L1: Map.get(key) ──────────────────┐
  │  O(1) average                       │   → JS Map's hash table
  └─────────────────────────────────────┘
                  (it flips)
  ┌─ L1 + L2: TTL check on hit ─────────┐
  │  cached.expiresAt > Date.now()      │   → still O(1), but conditional
  └─────────────────────────────────────┘
                  (it flips)
  ┌─ miss: liveCall (network) ──────────┐
  │  upstream RTT + ≥200ms spacing      │   → seconds, not nanoseconds
  └─────────────────────────────────────┘

  the hit/miss seam is where the lookup cost flips by ~6 orders of magnitude
```

**Seams** — one matters:

- The cache-hit / cache-miss boundary. On hit, `fromCache: true, durationMs: 0` rides back in the result envelope (`lib/data-source/bloomreach-data-source.ts:151`) and the UI's `StatusLog` shows a "cache" badge. On miss, the agent waits for a real network round-trip plus ~1s of rate-limit spacing. Same code path, two orders of magnitude difference in cost.

## How it works

### Move 1 — the mental model

You've used a hash table to dedupe network calls before — memoize a fetch by its URL, return the same response within a session. This is that, with two extras: a TTL so stale results expire, and a write-through behavior on forced refresh.

```
  Hash index pattern — keyed lookup with TTL

           call(name, args)
                │
                ▼
       key = `${name}:${JSON.stringify(args)}`
                │
                ▼
        cache.get(key)
           │       │
       HIT │       │ MISS
           │       │
           ▼       ▼
    fromCache    liveCall(name, args)
    durationMs=0       │
                       ▼
                  cache.set(key, { result, expiresAt: now+60s })
```

That's the kernel. The rest is two correctness rules layered on top.

### Move 2 — the index, one part at a time

#### The key — the only "hash function"

```typescript
// lib/data-source/bloomreach-data-source.ts:144
const cacheKey = `${name}:${JSON.stringify(args)}`;
```

The "hash" is the JS `Map` engine's; the key construction is just string concatenation. `JSON.stringify` is the load-bearing call — it serializes the args object deterministically (for a fixed key order) so two structurally-equal arg objects produce the same key.

**What breaks if you remove the `JSON.stringify`:** the key becomes `${name}:[object Object]`, every distinct args collapses to one entry, and the second `execute_analytics_eql` call returns the first call's result. Same shape of bug as a hash function that collides everything.

**The non-deterministic edge case:** `JSON.stringify` preserves key insertion order. Two calls with the same logical args but different key order (`{a:1, b:2}` vs `{b:2, a:1}`) produce different cache keys and miss. In practice the agent constructs args from a JSON tool schema, so order is stable per call site — but it's a latent foot-gun for a future caller that hand-builds args.

#### The TTL — bounded staleness

```typescript
// lib/data-source/bloomreach-data-source.ts:145
const ttl = options.cacheTtlMs ?? 60_000;

if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

The 60-second window is sized to the duration of one briefing — a monitoring scan plus a few investigations finish well inside a minute, so within one run the cache is effectively infinite. Across runs (different sessions or a later refresh) the cache is cold.

**What breaks if you remove the TTL:** the cache grows unboundedly within one process lifetime, and a stale result outlives the briefing it was captured for. That's not a memory crisis (the process recycles before the cache gets large) but it is a correctness leak — a long-running dev server would serve hour-old EQL results.

#### The two correctness rules

**Rule 1 — don't cache errors.**

```typescript
// lib/data-source/bloomreach-data-source.ts:179-181
// Don't cache error results — they should not poison the cache.
if ((result as any)?.isError === true) {
  return { result: result as T, durationMs, fromCache: false };
}
```

An `isError: true` result envelope (the MCP shape for "the tool ran but returned an error") never enters the cache. The next call gets a fresh attempt. Without this, a one-off 401 would mask every subsequent call for 60 seconds.

**Rule 2 — `skipCache` still write-throughs.**

```typescript
// lib/data-source/bloomreach-data-source.ts:184-186
// Note: a skipCache call still refreshes the cache (write-through), which is
// the desired behavior for the /debug "force fresh" path.
const now = Date.now();
this.cache.set(cacheKey, { result, expiresAt: now + ttl });
```

`/api/mcp/call` (the dev debug route) passes `skipCache: true` to force a live call. The result still updates the cache, so subsequent normal callers see the fresh value. This is the "force refresh" pattern from any HTTP cache — bypass on read, repopulate on write.

```
  Two-rule decision flow on a callTool

       result = liveCall(...)
            │
            ▼
       isError === true?
        ┌──┴──┐
        │     │
       YES    NO
        │     │
        ▼     ▼
   skip set    cache.set(key, { result, expiresAt: now+ttl })
   return      return { result, fromCache: false, durationMs }
```

#### What's *not* an index here

- `Insight.id`, `Investigation.insightId` — these are primary keys for the in-memory `Map`, not indexes (the Map IS the table; the key IS the only access path).
- `Insight.category` — looks like it could back a secondary index, but nothing actually indexes by it. The UI filters on read with `insights.filter(i => i.category === c)` — an O(N) scan. With ≤10 insights per session, that's fine. If the feed ever grew, this is where a `Map<CategoryId, Insight[]>` secondary structure would land.
- `sessionState` outer Map — primary key (sessionId → SessionFeed), not an index.

### Move 3 — the principle

When you're tempted to build a real index, first measure the N you're indexing. A 10-item array scanned per render doesn't need one. The 60s response cache earns its place because it converts a 1-second upstream call into a 0-millisecond hit — that's a real index-shaped win. The `category` "index" doesn't exist because the scan it would replace is over 10 items. Indexes are not free; build them only when the scan they replace shows up in a profile.

## Primary diagram

```
  The 60s response cache — full index walkthrough

  ┌─ caller (agent loop) ─────────────────────────────────────┐
  │  dataSource.callTool('execute_analytics_eql', { eql })     │
  └────────────────────────────┬─────────────────────────────┘
                               │
  ┌─ BloomreachDataSource ─────▼─────────────────────────────┐
  │                                                            │
  │  key = `execute_analytics_eql:{"eql":"..."}`               │
  │                                                            │
  │  ┌─ cache (Map<string, Entry>) ─────────────────┐          │
  │  │  "execute_analytics_eql:{...A}" → { ... }    │          │
  │  │  "list_segmentations:{}"        → { ... }    │          │
  │  │  "get_event_schema:{pid}"       → { ... }    │          │
  │  └──────────────────────────────────────────────┘          │
  │              │                                              │
  │              ▼                                              │
  │   ┌── HIT (within 60s) ────────────┐                       │
  │   │  return {                       │                       │
  │   │    result, durationMs: 0,       │                       │
  │   │    fromCache: true              │                       │
  │   │  }                              │                       │
  │   └─────────────────────────────────┘                       │
  │              │                                              │
  │   ┌── MISS ──▼─────────────────────────────────┐           │
  │   │  liveCall(name, args)  ──► Bloomreach MCP   │           │
  │   │       │                    (network)        │           │
  │   │       ▼                                     │           │
  │   │  if isError: skip cache, return             │           │
  │   │  else:       cache.set(key, { ... })        │           │
  │   │              return { fromCache: false }    │           │
  │   └─────────────────────────────────────────────┘           │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

The cache's design constraint came from the Bloomreach alpha server's rate limit (~1 req/s globally per user). Without a cache, a monitoring scan that re-issues the same EQL during investigation would burn the rate budget twice. With the cache, the second call is free. The comment at `lib/data-source/bloomreach-data-source.ts:135-137` explains why the retry delay defaults to 10 seconds — that's the observed penalty window when the cache miss *plus* the spacing fails to prevent a 429.

Compare to Postgres: a query plan cache, a shared buffer pool, and a result cache (via materialized views or `pg_buffercache`) all do similar work — turn repeat work into O(1) reads. The shapes are wildly different but the principle is the same: pay once at fill time, free reads until invalidation.

The thing this cache *doesn't* do that a real index would: range queries, ordering, joins. The `Map` only supports point lookups by exact key. If the agents ever needed "all EQL calls in the last 5 minutes" or "EQL calls grouped by metric," this structure couldn't answer that — they'd need a different shape.

## Interview defense

**Q: Is there an index anywhere in this codebase?**

The 60s response cache is the only thing that does an index's job — turn an expensive lookup into O(1). It's a `Map<string, { result, expiresAt }>` keyed by `${toolName}:${JSON.stringify(args)}`. Cache hit returns in 0ms with `fromCache: true`; miss does a network round-trip plus the ~1s rate-limit spacing.

```
  cache.get("execute_analytics_eql:{...A}") → { result, expiresAt }
       │
       ▼
  expiresAt > now?  →  HIT  →  fromCache: true,  durationMs: 0
                   →  MISS →  liveCall(...) ─► cache.set(...)
```

**Q: What's the most subtle correctness rule in the cache?**

Errors are never cached (`bloomreach-data-source.ts:179-181`). Without that, a transient 401 from token expiry would mask every subsequent call for 60 seconds — the user would see "everything's broken" until the cache expired, when actually only one call ever failed and the next would have succeeded.

**Q: When would you add a secondary index here?**

When a scan starts showing up in a profile. Right now `Insight.category` looks like a secondary-index candidate, but the feed has ≤10 insights, so the O(N) filter on the UI side is faster than the cost of maintaining a `Map<CategoryId, Insight[]>`. If the feed ever grew to thousands of insights per session (it won't — the monitoring agent is bounded), or if a server-side filter needed to run before send, that's where a secondary index would land.

## See also

- `01-database-systems-map.md` — where this cache sits among the four storage analogs (L2)
- `04-query-planning-and-execution.md` — what the cached calls actually do
- `06-locks-mvcc-and-concurrency-control.md` — why a single-writer cache needs no locking
- `09-database-systems-red-flags-audit.md` — the `JSON.stringify` key-order foot-gun

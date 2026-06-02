# B-tree, Hash, and Secondary Indexes

## Subtitle

How a database finds rows without scanning the whole table · Industry standard.

## Zoom out, then zoom in

```
  Zoom out — where indexes sit in a normal app

  ┌─ UI ──────────────────────────────────────────┐
  │  filters and sorts in the URL ("?since=2026")  │
  └────────────────────┬──────────────────────────┘
                       │
  ┌─ Service ──────────▼──────────────────────────┐
  │  queries with WHERE / ORDER BY / LIMIT         │
  └────────────────────┬──────────────────────────┘
                       │
  ┌─ Storage engine ───▼──────────────────────────┐
  │  ★ INDEXES ★                                   │
  │  B-tree (range + equality + sort)              │
  │  Hash    (equality only, no order)              │
  │  GIN/GiST (full-text, JSON, geospatial)         │
  └────────────────────┬──────────────────────────┘
                       │
  ┌─ Heap ─────────────▼──────────────────────────┐
  │  the rows themselves                           │
  └───────────────────────────────────────────────┘
```

### Verdict for this codebase

**Not yet exercised.**

The closest cousin: every `Map.get(key)` call is a hash-lookup — `insights.get(id)`, `cache.get(cacheKey)`, `mem.get(insightId)`. So technically we use "the hash index" for every lookup. What we don't have is any **secondary** index — there's no "find all insights by severity," no "find investigations created in the last hour," no `WHERE` / `ORDER BY` over a stored collection. Every query is a primary-key point lookup, by design.

When code does want to filter or sort the Map's values, it does it in JavaScript with `.filter()` / `.sort()` after `[...insights.values()]`. That's a full scan every time — fine at 50 items, would be wrong at 50K.

### When this becomes load-bearing

Three triggers, in order of likelihood:

1. **"give me all insights from this week"** — needs a B-tree on `timestamp`.
2. **"give me all insights for this user"** — needs a B-tree on `(user_id, timestamp)` once per-user data exists.
3. **"find insights mentioning the word 'checkout'"** — needs a full-text index (GIN in Postgres).

Until those queries exist, the only index in the codebase is the hash table V8 gives you for free.

## Structure pass

Skipped — no codebase instance to do a structure pass on.

## How it works

### Move 1 — the mental model

A B-tree is a sorted, fanned-out tree of pages where every leaf points at row locations. It answers two questions cheaply: "is this exact key present?" (log N descents) and "give me all keys in this range, in order" (descend once, walk leaves). A hash index answers only the first question — but in O(1) instead of O(log N).

```
  the pattern — B-tree, balanced + ordered leaves

                       ┌─ root ─┐
                       │ 50 | 100│              ← splits the key space
                       └──┬──┬──┬─┘
                          │  │  │
              ┌───────────┘  │  └────────────┐
              │              │               │
        ┌─ leaf ─┐      ┌─ leaf ─┐      ┌─ leaf ─┐
        │ 10..49 │ ───► │ 50..99 │ ───► │100..149│  ← leaves linked, so
        └────────┘      └────────┘      └────────┘     range scans are
            │               │               │          one descent + walk
            ▼               ▼               ▼
          rows…           rows…           rows…
```

```
  the pattern — hash index, bucket array

       hash(key) % N → bucket index
       ┌─────────────┬─────────────┬─────────────┐
       │  bucket 0   │  bucket 1   │  bucket 2   │  → row loc
       ├─────────────┼─────────────┼─────────────┤
       │  key→loc    │  key→loc    │  key→loc    │
       │  key→loc    │             │  key→loc    │  ← collisions chained
       └─────────────┴─────────────┴─────────────┘
```

### Move 2 — the moving parts

**Move 2a — B-tree, the default.** Postgres, MySQL InnoDB, SQLite all default to B-tree because it's the only structure that wins both point lookups and range scans. The cost is on writes — every insert walks the tree, potentially splitting pages.

Bridge: think of `Map.get(key)` (O(1) hash) vs `[...map.entries()].sort()` (O(N log N)). A B-tree is the in-between — O(log N) lookup but you also get sorted iteration for free.

**Move 2b — secondary index, the multiplier.** A primary key always has an index (it's how the row's location is found). A secondary index is any *other* index — on a column you query but didn't pick as the row identifier. The cost: every write to the table writes to every index too. Add five secondary indexes, every INSERT does six writes.

```
  what breaks when each part is missing

  drop the leaf-linkage     → range scans degrade to N descents instead of 1
  drop the balancing        → tree grows lopsided, lookups skew toward N not log N
  drop the index altogether → every WHERE clause becomes a full table scan
  add too many indexes      → writes get slower and slower; "I have an index for
                              every query" can mean "every write does 10 disk
                              writes"
```

**Move 2c — covering indexes.** An index that contains every column the query needs (in Postgres: `CREATE INDEX ... INCLUDE (...)`). The query never visits the heap; the index alone answers it. This is the difference between "use the index" and "use ONLY the index" — at scale, the latter can be 10× faster.

### Move 3 — the principle

**An index is a bet on which queries are hot.** Every index pays a write tax for a read discount. You don't index by default — you index by query pattern. The hardest indexing mistake is the one you can't see: an index that's there but never used (still costing writes) or a query that should use one but doesn't (slow but quiet).

## Primary diagram

Skipped — no codebase instance to recap.

## Implementation in codebase

### Use cases

None for "real" indexes. The pattern present here is **hash lookup as primary access** — every Map operation is `get(key)`.

### The closest cousin

```
  lib/state/insights.ts  (lines 44–54)

  export function getInsight(id: string): Insight | null {
    return insights.get(id) ?? null;        ← O(1) hash lookup. The "index"
                                               is V8's hash table for the Map.
  }

  export function listInsights(): Insight[] {
    return [...insights.values()];          ← full scan. No order, no filter.
                                               Sort and filter happens at the
                                               call site in JS.
  }
       │
       └─ if a future feature needs "insights by severity, newest first," this
          would become an O(N) filter + sort over the Map's values. At N=50,
          fine. At N=50K, you'd want a real secondary index. The migration
          target is straightforward: move to Postgres, define an index on
          (severity, timestamp DESC), drop the JS-side filter.
```

```
  lib/mcp/client.ts  (lines 102–110)

  const cacheKey = `${name}:${JSON.stringify(args)}`;
  ...
  const cached = this.cache.get(cacheKey);   ← also a hash lookup. Same shape.
                                                Key construction matters here —
                                                JSON.stringify is key-order
                                                sensitive, so two callers with
                                                {a:1,b:2} and {b:2,a:1} would
                                                miss each other's cache entries.
                                                In practice callers control
                                                args shape, so this never bites.
```

## Elaborate

The B-tree / hash split is older than relational databases — it's a 1970s data-structures result. The reason every modern OLTP database picks B-tree as the default is sorted range scans are *the* common access pattern in transactional systems ("give me the last N rows of X"). Hash indexes are reserved for narrow point-lookup tables (Postgres hash indexes exist but most teams never use them).

For blooming insights specifically, hash via `Map` is correct for everything we currently do. The day we want sorted access over a stored collection, we won't try to bolt a sort onto a Map — we'll have already moved to Postgres for other reasons.

Cross-link: `study-dsa-foundations` covers hash tables and trees as data structures. This file is the database-engine view — which structure the engine uses to find rows.

## Interview defense

**Q: "What indexes does this app have?"**
None of the database sort. JavaScript `Map`s give us hash lookup by primary key (the insight id, the MCP cache key). There's nothing else to query and nothing else to sort — every "give me an insight" call is a point lookup. The day a feature needs filtering or ordering across a collection, we'd be in Postgres territory; until then the only "index" is the V8 hash table.

Diagram: a Map with one column of buckets pointing at row records.

Anchor: `lib/state/insights.ts` L44 — `insights.get(id)` is the entire access pattern.

**Q: "If you added a saved-insights table, what indexes would you put on it?"**
Primary key on `id`. Secondary B-tree on `(user_id, created_at DESC)` — that's the dominant access pattern ("give me my recent saved insights"). I'd hold off on more indexes until a query proves it needs one. Every secondary index taxes writes; the worst mistake is having ten indexes "just in case."

Diagram: a B-tree with leaves linked, an arrow showing the range-scan walk.

Anchor: there is no such table today; this is hypothetical, and I'd say so in the interview.

## Validate

**Level 1 — reconstruct.** From memory, draw a B-tree with three levels and explain why a range scan touches log N + range_size pages, not N.

**Level 2 — explain.** Why don't we add an LRU eviction to `lib/mcp/client.ts`'s cache? (Answer: bounded TTL + bounded number of unique tool-call keys per session; the Map never grows large enough to need eviction in practice. If it ever did, you'd add a max-entries cap and an LRU.)

**Level 3 — apply.** A feature lands where the feed shows insights filtered by `severity === 'critical'`. Today it's `listInsights().filter(...)` in `lib/state/insights.ts`. At what scale does that filter need to become an index, and what's the migration look like?

**Level 4 — defend.** Argue against adding a "secondary index on severity" inside the in-memory `Map`s (i.e. maintaining a second `Map<Severity, Set<id>>`). (Answer: at current scale the filter is microseconds; the second Map is two writes per insert and a real chance of getting out of sync on the `clear()` calls. Wait until you're in a real DB before you reach for secondary indexes.)

## See also

- `02-records-pages-and-storage-layout` — where the rows live, that the index points at
- `04-query-planning-and-execution` — how the planner decides which index to use
- `study-dsa-foundations` — hash tables and trees as data structures

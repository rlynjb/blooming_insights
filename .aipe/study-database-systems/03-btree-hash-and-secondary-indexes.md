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

**Not yet exercised at the database-engine level.** No SQL, no B-trees, no secondary indexes. Every `Map.get(key)` call is a hash-lookup — `insights.get(id)`, `cache.get(cacheKey)`, `mem.get(insightId)`. We "use the hash index" for every lookup. When code wants to filter/sort, it does it in JS with `.filter()` / `.sort()`. Fine at 50 items, wrong at 50K.

### When this becomes load-bearing

Three triggers flip this from `not yet exercised` to load-bearing:

```
  trigger                                index it forces

  timestamp range queries                B-tree on (created_at) — descending
   "show insights from the last 7 days"    for newest-first scans

  user-scoped queries                    B-tree on (user_id, created_at DESC) —
   "show MY saved insights"                composite index, leftmost-prefix rule

  full-text search                       GIN index on a tsvector column
   "find insights mentioning 'churn'"      (Postgres-specific primitive)
```

## Structure pass

Skipped — no codebase instance.

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

The only "indexes" today are V8's internal hash tables backing every `Map`. The codebase doesn't write SQL, so there's nothing to teach about index selection in our code yet.

### Code side by side

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
       └─ at N=50 insights per briefing, fine. The migration target if this
          ever needed secondary indexing is Postgres with a B-tree on
          (severity, created_at DESC) — same shape, real engine, real index.
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
None at the database level — we don't have a database. JavaScript Maps give us hash lookup by primary key, and that's the only "index" present. When the code wants to sort or filter, it does it in JS against the Map's `values()` — full scan, fine at the scale we run (~50 items per briefing). The day we add Postgres for saved insights, the first index I'd write is a B-tree on `(user_id, created_at DESC)` — that's the dominant access pattern for any "show me my recent stuff" query.

Diagram: a 2-table picture with no indexes drawn, then a slide labeled "+saved_insights → +B-tree on (user_id, created_at DESC)."

Anchor: `lib/state/insights.ts` L4-6 for the Maps; `package.json` for the absence of DB drivers.

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

- `02-records-pages-and-storage-layout` — where the rows would live, that the index would point at
- `04-query-planning-and-execution` — also not exercised
- `study-dsa-foundations` — hash tables and trees as data structures

---
Updated: 2026-06-19 — Olist SQLite tier removed; verdict reverts to "not yet exercised." The 9-index Olist landscape is gone; section returns to teaching the concept generically with V8 Map hash-lookup as the only present cousin.

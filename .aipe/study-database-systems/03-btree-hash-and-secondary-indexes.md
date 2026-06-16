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

**Exercised — but only inside `mcp-server-olist/`. Main app still has no indexes.**

Two altitudes:

- **Main app:** every `Map.get(key)` call is a hash-lookup — `insights.get(id)`, `cache.get(cacheKey)`, `mem.get(insightId)`. We "use the hash index" for every lookup. No secondary indexes. When code wants to filter/sort, it does it in JS with `.filter()` / `.sort()`. Fine at 50 items, wrong at 50K.
- **Olist SQLite:** **9 named B-tree indexes** in `mcp-server-olist/scripts/seed-olist.ts` L236-244, plus 7 implicit indexes on PRIMARY KEYs. Every tool query relies on at least one. The B-tree teaching has real code to anchor to now.

```
  the 9 secondary B-trees in olist.db (each one is real)

  on orders:        idx_orders_purchase_ts  →  range scans for time_range
                    idx_orders_customer     →  customer join (FK)

  on order_items:   idx_items_order         →  order join (FK)
                    idx_items_product       →  product join (FK)

  on payments:      idx_payments_order      →  order join (FK)
                    idx_payments_type       →  payment_type dimension filter

  on reviews:       idx_reviews_order       →  order join (FK)

  on customers:     idx_customers_state     →  state dimension filter

  on products:      idx_products_category   →  category dimension filter
```

The dimension-filter indexes (`state`, `category`, `payment_type`) directly correspond to the three `DIMENSIONS` enum values in `mcp-server-olist/src/schemas.ts` L18. Every "group by dimension" query the agents can ask hits one of these.

### When this becomes load-bearing

For the **main app**, three triggers still apply (timestamp range, user-scoped query, full-text). For the **Olist DB**, indexes are already load-bearing: drop `idx_orders_purchase_ts` and every `get_metric_timeseries` query becomes a full scan of the orders table.

## Structure pass

```
  axis: "how does this code find the rows it needs?"

  ┌─ main app — Map ──────────────────────────────┐
  │  hash table by primary key only.              │  → no secondary indexes
  │  list/filter = full O(N) scan in JS           │     possible
  └────────────────────────────────────────────────┘
              │  cross into the Olist SQLite tier
              ▼
  ┌─ olist.db — B-tree everywhere ────────────────┐
  │  PK = clustered B-tree (one per table)         │  → SQLite picks an index
  │  9 secondary B-trees on FK + dim columns       │     per query via the
  │  range scans, equality lookups, JOIN paths     │     cost-based planner
  │   all hit indexes                              │     (see 04)
  └────────────────────────────────────────────────┘
```

The axis flips at the MCP subprocess boundary: from "no secondary indexes possible" to "the query planner picks one per JOIN."

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

```
  olist.db — the index landscape

  ┌─ orders ────────────────────────────────────────┐
  │  PK B-tree: orders.id                            │  ← clustered, the heap
  │  idx_orders_purchase_ts  →  range scans          │
  │  idx_orders_customer     →  customer join (FK)   │
  └───────────────┬──────────────────────────────────┘
                  │  JOIN orders.id = items.order_id
                  ▼
  ┌─ order_items ───────────────────────────────────┐
  │  idx_items_order   →  the FK index               │
  │  idx_items_product →  for product joins          │
  └───────────────┬──────────────────────────────────┘
                  │  JOIN items.product_id = products.id
                  ▼
  ┌─ products ──────────────────────────────────────┐
  │  PK B-tree: products.id                          │
  │  idx_products_category  →  category filter/group │
  └──────────────────────────────────────────────────┘

   every JOIN in get_metric_timeseries walks one of these B-trees;
   every GROUP BY dimension hits the dim-column index.
```

## Implementation in codebase

### Use cases

- **Every Olist tool query** uses at least one index. `get_metric_timeseries` with `dimension: 'state'`, `time_range: {...}` hits `idx_orders_purchase_ts` (range scan) + `idx_customers_state` (group/filter).
- **Every Map lookup in the main app** uses the V8 hash-table primary key. `insights.get(id)`, `cache.get(cacheKey)`, `mem.get(insightId)`.

### The real indexes (Olist)

```
  mcp-server-olist/scripts/seed-olist.ts  (lines 236–244)

  CREATE INDEX idx_orders_purchase_ts ON orders(purchase_ts);
  CREATE INDEX idx_orders_customer    ON orders(customer_id);
  CREATE INDEX idx_items_order        ON order_items(order_id);
  CREATE INDEX idx_items_product      ON order_items(product_id);
  CREATE INDEX idx_payments_order     ON payments(order_id);
  CREATE INDEX idx_reviews_order      ON reviews(order_id);
  CREATE INDEX idx_customers_state    ON customers(state);
  CREATE INDEX idx_products_category  ON products(category);
  CREATE INDEX idx_payments_type      ON payments(type);
       │
       └─ five categories of index here, each load-bearing for a different
          query shape:
          
          time-range scan:   idx_orders_purchase_ts (the ONE non-FK, non-dim
                              index — without it every metric query is a full
                              orders scan)
          FK join paths:     idx_orders_customer, idx_items_order, idx_items_
                              product, idx_payments_order, idx_reviews_order
                              (SQLite does NOT auto-index FK columns; you must
                              create these by hand)
          dim filter/group:  idx_customers_state, idx_products_category,
                              idx_payments_type — the three DIMENSIONS the
                              schema exposes to agents
          PK (implicit):     each table's PRIMARY KEY gets a B-tree for free
          
          dropping any FK index would force a full table scan on the joined
          side for every metric query.
```

```
  lib/state/insights.ts  (lines 44–54)  — the main-app cousin, unchanged

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
          ever needed secondary indexing is the Olist pattern: move to
          SQLite (or Postgres), define indexes on (severity, timestamp DESC),
          drop the JS-side filter. We've now done that pattern once in the
          repo — Olist is the worked example.
```

```
  lib/mcp/client.ts  (lines 102–110)  — the MCP cache, also a hash

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
Two altitudes. The main Next.js app has no indexes — JavaScript Maps give us hash lookup by primary key, nothing else. The sibling Olist MCP server has nine named B-tree indexes in `mcp-server-olist/scripts/seed-olist.ts` L236-244: one for time-range scans on `orders.purchase_ts`, five for foreign-key joins (SQLite doesn't auto-index FK columns), and three on the dimension columns the agents can filter by — `customers.state`, `products.category`, `payments.type`. Every domain tool query relies on at least one. Drop `idx_orders_purchase_ts` and every metric timeseries query becomes a full scan.

Diagram: the index-landscape from the Primary diagram, showing how a metric query walks orders → items → products via three index B-trees.

Anchor: `mcp-server-olist/scripts/seed-olist.ts` L236-244 for the CREATE INDEX statements; `mcp-server-olist/src/tools/get_metric_timeseries.ts` for the join shape they support.

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
- `04-query-planning-and-execution` — how SQLite's planner picks among these 9 indexes
- `10-embedded-sqlite-fixture` — why we chose SQLite + 9-index design here
- `study-dsa-foundations` — hash tables and trees as data structures

---
Updated: 2026-06-16 — now exercised; 9 named B-tree indexes in mcp-server-olist/scripts/seed-olist.ts L236-244 grounded with shape + use case per index.

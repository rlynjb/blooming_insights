# Records, Pages, and Storage Layout

## Subtitle

How a database physically arranges bytes on disk · Industry standard.

## Zoom out, then zoom in

```
  Zoom out — where storage layout lives in a normal app

  ┌─ UI ──────────────────────────────────────────┐
  │  reads/writes records, doesn't see pages       │
  └────────────────────┬──────────────────────────┘
                       │
  ┌─ Service ──────────▼──────────────────────────┐
  │  queries refer to rows, not byte offsets       │
  └────────────────────┬──────────────────────────┘
                       │
  ┌─ Storage engine ───▼──────────────────────────┐
  │  ★ STORAGE LAYOUT ★                            │
  │  rows → pages → segments → files               │
  │  cache hot pages in the buffer pool            │
  └────────────────────┬──────────────────────────┘
                       │
  ┌─ Disk ─────────────▼──────────────────────────┐
  │  bytes on an SSD, page-aligned                 │
  └───────────────────────────────────────────────┘
```

### Verdict for this codebase

**Exercised — but only on the Olist side. Main app still has no pages.**

Two altitudes:

- **Main app:** the closest cousin is a JavaScript `Map`. `Map.get(key)` is one V8 hash-table probe and a pointer dereference. No pages, no buffer pool, no row format. V8's heap is the storage engine and we don't tune it.
- **`mcp-server-olist/data/olist.db`:** a real SQLite database file. SQLite uses a default page size of 4096 bytes (4KB), B-tree-organized, with each table stored in its own B-tree and each index in another. The `.db` file is 3.5 MB on disk — roughly 900 pages of data + ~9 pages × 9 indexes of index pages.

When you open the file with `sqlite3 mcp-server-olist/data/olist.db` and run `PRAGMA page_size` and `PRAGMA page_count`, you get real answers. This is the first time this guide has actual page numbers to point at.

### When this becomes load-bearing

For the **main app**, storage layout still matters only when a query is CPU- or I/O-bound on bytes we own — none of the main app's code is that. Triggered by adding Postgres or DuckDB.

For the **Olist DB**, layout already matters because the tool queries are real SQL with real JOINs. The teaching has concrete anchors now:

```
  axis: "which query plan benefits from row vs columnar layout for THIS data?"

  get_metric_timeseries     ← row-store wins. Per-bucket SUM over (purchase_ts,
   ('revenue', 'state')        state) — joins customers + order_items + orders,
                               filters on purchase_ts range, groups by state.
                               Row-store hits the index range scan, then heap
                               fetches per row. Columnar would help if we were
                               summing one column across millions of rows — at
                               ~10k orders, the index seek + sequential heap
                               scan is faster.

  get_anomaly_context       ← still row-store. Two windowed aggregates over
   (anomaly + baseline)        the same shape. Columnar would matter at 10M+
                               rows.
```

At the size of the Olist fixture, **row-store with B-tree indexes is correct**. SQLite picks this by default; we don't tune it. The skill the file teaches is recognizing when you'd switch (columnar parquet / DuckDB / ClickHouse): hundreds of millions of rows, narrow analytical scans, no point lookups.

## Structure pass

Two altitudes; one axis flips at the boundary.

```
  axis: "what is the unit of I/O for this storage?"

  ┌─ main app — Map<id, Insight> ────────────────┐
  │  unit of I/O: one V8 hash-table probe         │  → no I/O at all; in RAM
  │  no pages, no disk                            │
  └────────────────────────────────────────────────┘
              │  cross the MCP subprocess boundary
              ▼
  ┌─ Olist SQLite — data/olist.db ───────────────┐
  │  unit of I/O: one 4KB page                    │  → real disk I/O; the
  │  ~900 data pages + ~80 index pages            │     buffer pool caches
  │  buffer pool: SQLite's default 2000-page      │     hot pages; cold pages
  │   cache (~8 MB)                               │     come from disk
  └────────────────────────────────────────────────┘
```

The seam is the MCP subprocess boundary. On the main-app side, "storage layout" is a non-question. On the Olist side, it's the question SQLite's planner asks every time.

## How it works

(General teaching, since the codebase has no instance.)

### Move 1 — the mental model

A database row isn't a row on disk. It's a small slice of a fixed-size **page** (typically 4KB or 8KB), and the page is the unit of I/O. The database reads a whole page at a time and pulls the row out of it. This is the same trick the CPU uses with cache lines — you can't read one byte, you read a whole line, so pack what you read together.

```
  the pattern — rows packed into fixed-size pages

       ┌─ page (8KB) ──────────────────────────────────────┐
       │ header │ row1 │ row2 │ row3 │ ... │ free space    │
       └────────┴──────┴──────┴──────┴─────┴───────────────┘
                  ▲       ▲       ▲
                  │       │       │
            small rows pack many per page → fewer reads per scan

       ┌─ page (8KB) ──────────────────────────────────────┐
       │ header │       row1 (BLOB column)                  │
       └────────┴──────────────────────────────────────────┘
                  ▲
                  │
            big rows fill a page → more reads per scan, worse locality
```

### Move 2 — the moving parts

**Move 2a — pages.** Fixed-size I/O units, the unit the buffer pool caches. If your row is 200 bytes, you fit ~40 of them on an 8KB page; a sequential scan of 1M rows is ~25K page reads, not 1M.

```
  bridge: think of a fetch waterfall. one HTTP request can return a list of 50
          items, or a single item. you pay one RTT either way. pages are the same
          tradeoff at the disk level.
```

**Move 2b — row vs columnar layout.** Row-store packs all of a row's columns together (good for "give me this user's row" queries). Column-store packs all values of one column together (good for "give me the average of this column across 1M rows" queries). Same data, different physical layout, different access patterns win.

```
  row-store           column-store
  ──────────          ────────────
  [u1: name, age, x]  names:  [u1, u2, u3, u4, ...]
  [u2: name, age, x]  ages:   [u1.age, u2.age, ...]
  [u3: name, age, x]  x:      [u1.x, u2.x, u3.x, ...]
  [u4: name, age, x]
```

**Move 2c — locality and the heap.** A Postgres heap is unordered — rows go wherever there's space. Clustered indexes (Postgres `CLUSTER`, MySQL InnoDB primary key) re-order the heap to match an access pattern. Without clustering, rows logically near each other can be physically scattered, so a "give me all insights from this week" scan touches more pages than it needs to.

### Move 3 — the principle

**Physical layout determines which queries are cheap.** A schema that's normalized into five tables looks elegant on paper, but if your access pattern always joins those five tables on the same key, you're paying for five separate page lookups every time. Picking row vs column store, picking a clustering key, picking a fill factor — these are all bets on which access pattern is hot.

## Primary diagram

Skipped — no codebase instance to recap.

## Implementation in codebase

### Use cases

- **The Olist DB file** holds ~10k orders, 5k customers, ~30k rows total, across 7 tables. Every tool query in `mcp-server-olist/src/tools/*.ts` reads from these pages.
- **The seed script** (`mcp-server-olist/scripts/seed-olist.ts` L508-544) writes all of them in one transaction; SQLite serializes the writes onto pages, splitting B-tree leaves as needed.
- **The main-app Maps** still hold the in-flight briefing state (`lib/state/insights.ts` L4-6).

### The Olist DB on disk

```
  mcp-server-olist/data/olist.db  (3.5 MB, committed)
  mcp-server-olist/src/db.ts      (L29-43)

  export function openDb(path = resolveDbPath()): Database.Database {
    if (!existsSync(path)) {
      throw new Error('olist.db not found ...');
    }
    const db = new Database(path, {
      readonly: true,                        ← page cache populated read-only;
      fileMustExist: true,                      no risk of accidental writes
    });
    db.pragma('journal_mode = WAL');         ← WAL files (.db-wal, .db-shm)
    db.pragma('foreign_keys = ON');             will be created on first read;
    return db;                                  see 07 for why WAL matters
  }
       │
       └─ SQLite's default page_size is 4096 bytes. With ~30k rows across
          7 tables, the data B-trees occupy ~900 pages. The 9 secondary
          indexes (see 03) add another ~80 pages. Total file: ~1000 pages
          × 4KB ≈ 4 MB raw; compressed-on-disk varies, observed 3.5 MB.
```

### Indexes side by side (where the layout work lives)

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
       └─ each index is its own B-tree, stored in its own pages. INSERT into
          orders therefore writes to TWO B-trees: the orders heap-page B-tree
          (keyed by id PK) AND the idx_orders_purchase_ts B-tree. That's the
          write tax discussed in 03 Move 2b. At seed time (~30k inserts wrapped
          in one transaction), the cost is paid once and amortized.
```

### Still the cousin on the main-app side

```
  lib/state/insights.ts  (lines 4–6)

  const insights      = new Map<string, Insight>();
  const investigations = new Map<string, Investigation>();
  const anomalies     = new Map<string, Anomaly>();
       │
       └─ V8 hash table. No pages. At ~10-50 insights per briefing this is
          correct. If this Map ever held 100K insights we'd want a real
          engine — and the Olist server is the worked example of how to
          stand one up locally.
```

## Elaborate

Storage layout is one of the few database topics where the abstraction *almost* matters at every layer of the stack. CPU cache lines, OS page cache, database pages, columnar parquet files — they're all the same trick at different scales: read more than you need so the next read is free, and arrange data so the things you read together are stored together.

For this codebase, the relevant lift is none until persistence enters the picture. The MCP cache (`Map<key, {result,expiresAt}>`) doesn't care about layout — it's hash-lookup, no scans.

Cross-link: `study-data-modeling` would own the conversation about how to SHAPE the rows. This file owns the conversation about how the rows would be PHYSICALLY laid out — relevant only once both files have something to point at.

## Interview defense

**Q: "How does your app store its data on disk?"**
Honest answer: it doesn't. State lives in `Map`s inside the Node process; auth lives in an encrypted cookie. The upstream data warehouse is Bloomreach, and they handle storage layout — we never see it. If I were adding persistence, I'd start with Postgres for the saved-insights table, take the 8KB page default, and only revisit layout once a query is provably bound on page I/O.

Diagram: a generic page diagram with rows packed; an arrow off to "our Maps live here, none of this applies yet."

Anchor: `package.json` has no DB dependencies.

## Validate

**Level 1 — reconstruct.** Draw an 8KB page with five row slots. Explain why a 200-byte row is 40-per-page and a 2KB row is 4-per-page.

**Level 2 — explain.** Name one access pattern row-store is faster for and one column-store is faster for.

**Level 3 — apply.** If we added a "saved insights" table and the dominant query is "give me this user's last 20 saved insights, newest first," what's the right index and clustering choice? (Answer: B-tree index on `(user_id, created_at DESC)`, clustering optional but helpful at scale.)

**Level 4 — defend.** Argue against premature columnar storage for the saved-insights table. (Answer: row-store wins for OLTP point lookups; you only switch to columnar when analytical scans across all users dominate — that's a usage shift, not a feature ship.)

## See also

- `01-database-systems-map` — what storage actually exists here (both altitudes)
- `03-btree-hash-and-secondary-indexes` — the 9 indexes that point AT these pages
- `04-query-planning-and-execution` — how SQLite picks which pages to scan
- `10-embedded-sqlite-fixture` — better-sqlite3 specifics + seed determinism
- `study-data-modeling` — how to shape what you'd store

---
Updated: 2026-06-16 — now exercised via mcp-server-olist SQLite (4KB pages, 9 indexes, ~30k rows in 3.5 MB). Main-app verdict unchanged.

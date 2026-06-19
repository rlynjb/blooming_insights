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

**Not yet exercised.** No database, no pages, no rows on disk. The closest cousin is a JavaScript `Map`. `Map.get(key)` is one V8 hash-table probe and a pointer dereference. No pages, no buffer pool, no row format. V8's heap is the storage engine and we don't tune it.

### When this becomes load-bearing

Storage layout matters only when a query is CPU- or I/O-bound on bytes we own — none of this codebase's code is that. The trigger is **adding a real engine** (Postgres for saved insights, DuckDB for analytics, etc.). At that moment the access pattern dictates the layout: row-store for OLTP point lookups, columnar for analytical scans across millions of rows.

## Structure pass

Skipped — no codebase instance.

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

None today. The closest analog is the `Map` in `lib/state/insights.ts` — a V8 hash table that doesn't expose pages or layout. If you're learning this concept for the first time, the right move is to mock up a small Postgres locally and read its EXPLAIN output; this codebase won't teach you record-and-page mechanics.

### The closest cousin

```
  lib/state/insights.ts  (lines 4–6)

  const insights      = new Map<string, Insight>();
  const investigations = new Map<string, Investigation>();
  const anomalies     = new Map<string, Anomaly>();
       │
       └─ V8 hash table. No pages. At ~10-50 insights per briefing this is
          correct. If this Map ever held 100K insights we'd want a real
          engine — Postgres for saved/historical insights, or an external KV
          for ephemeral cross-instance state.
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

- `01-database-systems-map` — what storage actually exists here (none)
- `03-btree-hash-and-secondary-indexes` — the lookup structures, also not exercised
- `04-query-planning-and-execution` — also not exercised
- `study-data-modeling` — how to shape what you'd store

---
Updated: 2026-06-19 — Olist SQLite tier removed; verdict reverts to "not yet exercised." Section now teaches the concept generically and names the trigger that would activate it.

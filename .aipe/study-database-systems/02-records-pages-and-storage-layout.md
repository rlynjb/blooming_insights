# Records, pages, and storage layout

Industry standard · Storage engine internals

## Zoom out — where storage layout would live, and what's there instead

Real database engines spend most of their cleverness on storage layout — how rows pack into pages, how pages live on disk, how the buffer pool warms them into memory, what gets read together. None of that exists here. The "table" is a JavaScript `Map`; the "page" is whatever V8 happens to allocate; the "buffer pool" is the heap.

```
  Zoom out — where storage layout would matter (and what's there)

  ┌─ Service layer ──────────────────────────────────────────────┐
  │  putInsights · getInsight · listInsights                      │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ Map.get / Map.set
  ┌─ "Storage" layer ──────────────▼──────────────────────────────┐
  │  ★ THIS CONCEPT ★                                              │
  │  Map<sessionId, SessionFeed>           ← the "namespace"       │
  │    Map<string, Insight>      insights   ← the "table"          │
  │    Map<string, Investigation> investigations                   │
  │    Map<string, Anomaly>      anomalies                         │
  │                                                                │
  │  no page layout, no row format, no buffer pool                 │
  │  every Insight is a JS object living wherever V8 put it        │
  └────────────────────────────────────────────────────────────────┘
                                  │ (provider owns real storage)
                                  ▼
                       Bloomreach Engagement
```

## Zoom in — the question this concept answers

In a real engine: "what's on disk and how does it get into memory efficiently?" Here: "what does a 'row' look like, what does a 'table' look like, and what guarantees do we have about layout?" Answer: a row is a TypeScript object, a table is a `Map<string, T>`, and the only layout guarantee is insertion order. That's it.

## Structure pass — the skeleton

### Layers in a real engine vs this repo

```
  layer                  real RDBMS                  this repo
  ─────────────────      ─────────────────           ─────────────────────
  table                  named relation, schema      Map<string, T>
  row format             tuple bytes (NULL bitmap,   JS object reference
                         varlen, fixed cols)
  page                   8KB block, header + slots   N/A (heap allocation)
  buffer pool            page cache in RAM           N/A (heap is the cache)
  on-disk file           .ibd / heap file            N/A (no persistence)
  free space mgmt        FSM page, vacuum            N/A (GC handles it)
```

### Axis: where does locality come from?

In a real engine: from co-locating related rows on the same page (clustered index, table partitioning, columnar layout). Here: from nothing. `Map` insertion order is the only layout discipline, and the iteration order it gives you is the only "scan" you get.

### Seams

The interesting seam is between **the type** (`Insight`, `Investigation`, `Anomaly`) and **the storage** (the `Map`). In a real engine that seam is the row-format codec. Here it's `JSON.stringify`/`JSON.parse` for serialization (when we cross to disk for the demo snapshot) and *nothing* for in-memory storage — the type IS the layout.

## How it works

### Move 1 — the mental model

If you've ever done `const users = new Map<string, User>(); users.set(u.id, u);` — that's literally the storage layer of this codebase. There's no second tier, no page cache, no flush. The `User` object lives in the heap wherever V8 put it; the `Map` holds a reference.

```
  The shape — table-as-Map

      Map<string, Insight>
   ┌──────────────────────────────────┐
   │  "abc-123" ───► { id, summary, … }│  ← row 1: reference to heap object
   │  "def-456" ───► { id, summary, … }│  ← row 2: somewhere else in heap
   │  "ghi-789" ───► { id, summary, … }│  ← row 3
   └──────────────────────────────────┘
       ▲                ▲
       │                │
       primary key      "row" = JS object reference
       (hash-indexed)   no co-location guarantees
```

### Move 2 — the walkthrough

#### A "row" is a TypeScript interface

The schema lives in `lib/mcp/types.ts`:

```ts
// lib/mcp/types.ts (Insight shape)
export interface Insight {
  id: string;
  timestamp: string;
  severity: Severity;
  headline: string;
  summary: string;
  metric: string;
  change: { value: number; direction: 'up' | 'down'; baseline: string };
  scope: string[];
  source: 'monitoring';
  evidence?: Array<{ tool: string; result: unknown }>;
  impact?: string;
  history?: unknown;
  category?: string;
}
```

In a real engine the row format would specify byte offsets per column, NULL bitmap position, varchar length prefix. Here it specifies *only* what TypeScript checks at compile time — at runtime the object is a plain V8 hidden-class instance. Optional fields (`?`) are absent properties, not NULL markers.

The deliberate convention in this repo: **new fields stay optional so older snapshots still validate.** From the project context: "new fields stay optional so older snapshots still validate." That's the schema-evolution discipline that substitutes for a migration system.

#### The table (`Map<string, T>`) — keyed by primary key

```ts
// lib/state/insights.ts:8-12
type SessionFeed = {
  insights: Map<string, Insight>;
  investigations: Map<string, Investigation>;
  anomalies: Map<string, Anomaly>;
};
```

Annotation:
  - The key type is `string` — always the `id` (or `insightId` for investigations). No composite keys, no autoincrement, no surrogate-vs-natural choice. The key is supplied by the row.
  - The value type is the row type directly. There's no row codec, no serialization, no buffer pool. The value is a heap reference.
  - There's *no* secondary structure — no separate index Map, no sorted view, no by-severity bucket. If you want insights-by-severity, you iterate the whole Map and filter. That's a full scan. → see `03-btree-hash-and-secondary-indexes.md`.

#### The full table scan (`Map.values()`)

```ts
// lib/state/insights.ts:81-84
export function listInsights(sessionId: string): Insight[] {
  const s = state.get(sessionId);
  return s ? [...s.insights.values()] : [];
}
```

Annotation:
  - `Map.values()` returns an iterator in **insertion order**. That is the entire scan story.
  - Spreading into an array materializes the full result set every call — no streaming, no cursor, no LIMIT/OFFSET pagination. The dataset is small enough (today's briefing is ~6–12 insights) that this is fine.
  - There is no equivalent of an index-only scan, a covering index, or a sequential scan with a WHERE pushdown. The filter, if any, happens in JS on the array.

#### Pages don't exist — the V8 heap is the only layout

In a real engine, the moment you store thousands of rows you start caring about which rows share a page, because reading one row brings the rest of its page into the buffer pool. Here, every `Insight` is a separate heap allocation. There is no spatial locality, no read-ahead, no page-level eviction.

```
  Real engine                       This repo

   ┌─ page (8KB) ─────┐                heap (V8-managed)
   │ row 1 │ row 2 │  │             ┌──────────────────────┐
   │ row 3 │ row 4 │  │             │ obj1                 │
   │ row 5 │ row 6 │  │             │       obj2           │
   └──────────────────┘             │              obj3    │
   read one → all in RAM            │  obj4                │
                                    └──────────────────────┘
                                    references in a Map; no co-location
```

The cost difference doesn't matter at the scale this app runs at. The conceptual difference matters when you try to reason about *why* a real database is fast at things like "give me all insights from the last hour" — the answer is "they're on adjacent pages," and the equivalent here is "you iterate every entry."

#### The committed demo snapshot is the only "on-disk format"

When state actually has to cross to disk, the format is JSON:

```ts
// lib/state/investigations.ts:34-37
const all = readJson(CACHE_FILE);
all[insightId] = events;
try {
  writeFileSync(CACHE_FILE, JSON.stringify(all));
```

Annotation:
  - Format: a single JSON object, keyed by primary key, value is the row. Same shape as the in-memory Map.
  - Write: whole-file rewrite. Every save reads the entire file, mutates the in-memory object, writes it back. That's `O(n)` per write — fine for tens of investigations, would be a disaster for thousands. Real DBs solved this with append-only files + checkpointing (→ see `07-wal-durability-and-recovery.md`).
  - No row-level locking, no fsync discipline, no atomic rename. A crash mid-write leaves a truncated JSON file (which the read-side handles with `try/catch` → returns `{}`).

This is the closest the codebase gets to a "storage format," and it's a dev-only convenience, not a production path.

### Move 3 — the principle

Storage layout matters when *getting bytes from disk to CPU* is the bottleneck. When your dataset fits in RAM and your durability requirement is zero, the layout question collapses: store whatever object you have, in whatever order you got it. The discipline of database storage engines is what you reach for the moment one of those two assumptions breaks.

## Primary diagram

```
  Storage layout for this repo — flat and reference-shaped

  ┌─ Map<sessionId, SessionFeed> ────────────────────────────┐
  │                                                            │
  │  "session-A" ──► SessionFeed                              │
  │                  ├── insights:       Map<string, Insight> │
  │                  │     "ins-1" ─► { id, ... }             │
  │                  │     "ins-2" ─► { id, ... }             │
  │                  ├── investigations: Map<string, Inv>     │
  │                  └── anomalies:      Map<string, Anomaly> │
  │                                                            │
  │  "session-B" ──► SessionFeed                              │
  │                  ├── insights                              │
  │                  ├── investigations                        │
  │                  └── anomalies                             │
  └────────────────────────────────────────────────────────────┘
       ▲             ▲                ▲
       │             │                │
   namespace     "table"          "row" (JS object reference)
   (sessionId)   (named Map)      (heap-allocated, no layout discipline)
```

## Elaborate

The classical references for storage layout (Hellerstein & Stonebraker's "Anatomy of a Database System," Pavlo's CMU 15-445) treat the page as the atomic unit because disk I/O is the dominant cost. When your "disk" is RAM and your "page" is a heap allocation, those lessons reshape: you start caring about *cache lines* (CPU L1/L2/L3) and *allocator behavior* instead of page layout. Columnar engines like DuckDB and ClickHouse push this further — they rearrange data by column to maximize SIMD throughput. None of that is relevant for ~12 insights in a Map, but it's the next altitude of "storage layout matters" if the local dataset ever grew.

For this codebase, the actionable read is: the storage layout question gets *answered when product asks for a feature that requires it.* "Show me yesterday's briefing" requires persistence + a time index. "Show me which insights I've already investigated" requires either a flag column or a join. Neither has been asked for. When they are, the storage layout decision lands at the same time as the datastore decision.

## Interview defense

> Q: "What's the storage layout in this app?"

Verdict: there isn't one in the database-engine sense. The "tables" are `Map<string, T>` keyed by primary key; the "rows" are TypeScript interfaces; every value is a V8 heap reference with no co-location guarantees. The only on-disk format is JSON — used dev-only for the auth cache and investigation cache, and for the committed demo snapshot.

```
  the picture you draw — Map → row reference

   Map<"id", Insight>  ──►  { id, summary, change, ... }
       (hash index)             (V8 heap object)
```

The load-bearing point: this app's working dataset is tiny (~12 insights per briefing), it fits trivially in RAM, and it's all derivative from upstream Bloomreach. There's no I/O bottleneck to optimize against, so the storage engine machinery doesn't earn its weight.

> Q: "What changes the day you need real storage?"

Two things land together: a datastore decision (Postgres? a KV like Redis? a managed serverless DB?) and a row format (do we serialize the JS object as JSON in a `jsonb` column, or do we shred it into typed columns?). The current `Insight` type is JSON-shaped — variant by source, optional fields — so the first cut is almost certainly a `jsonb` column with a few indexed top-level fields (`severity`, `timestamp`). Real schema-shred comes later if query patterns demand it.

## See also

  - [`03-btree-hash-and-secondary-indexes.md`](./03-btree-hash-and-secondary-indexes.md) — what indexes you'd add on top of these "tables"
  - [`07-wal-durability-and-recovery.md`](./07-wal-durability-and-recovery.md) — what "no on-disk format" means for restart
  - `.aipe/study-data-modeling/` — the schema shape and access patterns

# B-tree, hash, and secondary indexes

Industry standard · Storage engine internals

## Zoom out — where indexes would live, and what this repo has instead

Indexes are how a database avoids reading every row. A B-tree gives you sorted range scans; a hash index gives you `O(1)` equality lookup; a secondary index lets you look up by something other than the primary key. This codebase has **exactly one index of any kind: the primary-key hash index that comes for free with `Map<string, T>`.**

```
  Zoom out — where indexes would matter (and what's there)

  ┌─ Service layer ──────────────────────────────────────────────┐
  │  getInsight(sessionId, id)       ← primary-key lookup (Map.get) │
  │  listInsights(sessionId)         ← full scan (Map.values)       │
  │  filter by severity              ← scan + JS filter             │
  │  filter by metric                ← scan + JS filter             │
  │  filter by scope                 ← scan + JS filter             │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ Map.get / Map.values
  ┌─ "Index" layer ────────────────▼──────────────────────────────┐
  │  ★ THIS CONCEPT ★                                              │
  │  • ONE hash index: the primary-key Map itself                  │
  │  • NO secondary indexes                                        │
  │  • NO range-queryable structure (no B-tree)                    │
  │  • every non-PK lookup is a full scan in JS                    │
  └────────────────────────────────────────────────────────────────┘
```

## Zoom in — the question this concept answers

A real engine asks: "given a query, can the planner reach the rows without reading the table?" Here the answer is binary — yes if you have the primary key, no for anything else. Every other lookup is a JavaScript filter over the materialized array.

## Structure pass — the skeleton

### Two index families to know

  - **Hash index.** `O(1)` average lookup. Equality only. No range, no ordering, no prefix match. A `Map<K, V>` is one. This is what every primary-key lookup uses.
  - **B-tree (or B+tree).** `O(log n)` lookup. Sorted, so it answers `=`, `<`, `>`, `BETWEEN`, prefix matches, and `ORDER BY`. The default index type in nearly every RDBMS (Postgres, MySQL, Oracle). This codebase has zero of these.

### Axis: what access patterns does the existing index serve?

```
  The "supported access pattern" axis

  pattern                             this repo's index supports it?
  ─────────────────────────────       ──────────────────────────────
  getInsight(id)                      yes — Map.get O(1)
  listInsights()                      yes — Map.values (full iter)
  insights where severity='critical'  no  — scan + filter
  insights where metric='revenue'     no  — scan + filter
  insights ordered by timestamp       no  — scan + sort
  insights from last 24h              no  — scan + filter
```

Notice the asymmetry: one pattern is supported by structure, all others by *iteration*. In a real engine each of those "no" rows would be a candidate for a secondary index. Here, every "no" pays the cost of a full scan — which is fine at ~12 entries and would NOT be fine at 12,000.

### Seams

The interesting seam is between **the Map (the only index)** and **the application filters (everything else).** In a real engine the planner sits at that seam and decides whether to use an index or scan. Here there's no planner; the call site picks: `getInsight` uses the index, everything else iterates.

## How it works

### Move 1 — the mental model

You already know the shape. A JavaScript `Map` IS a hash index. You learned this when you reached for `Map.get(id)` instead of `array.find(x => x.id === id)` and got an `O(1)` lookup instead of `O(n)`. That's the entire index story in this repo.

```
  The shape — two index families, and which one we have

  HASH INDEX                    B+TREE INDEX
  ─────────────                 ─────────────
  unordered                     sorted
  O(1) equality                 O(log n) eq + range
  no range scan                 range, prefix, ORDER BY
                                
  ┌──────────────────┐         ┌─────────────────────┐
  │ hash(key) → slot │         │     [root]          │
  │ slot → row ref   │         │    /  |  \          │
  └──────────────────┘         │  [leaf][leaf][leaf] │
   ← Map<K,V> is this          │  rows linked across │
                                │  for range scan     │
                                └─────────────────────┘
                                  ← this repo has ZERO of these
```

### Move 2 — the walkthrough

#### The one index that exists: `Map<string, T>` as primary-key hash

```ts
// lib/state/insights.ts:73-79
export function getInsight(sessionId: string, id: string): Insight | null {
  return state.get(sessionId)?.insights.get(id) ?? null;
}

export function getAnomaly(sessionId: string, id: string): Anomaly | null {
  return state.get(sessionId)?.anomalies.get(id) ?? null;
}
```

Annotation:
  - `state.get(sessionId)` — first hash lookup, `O(1)`. Picks the right "namespace."
  - `.insights.get(id)` — second hash lookup, `O(1)`. The primary-key index on the "insights table."
  - `?? null` — explicit "not found" return; equivalent to a SQL `SELECT ... WHERE id = ?` returning zero rows.

This pattern is the ONLY lookup in the codebase that uses an index. Every other access (filter by severity, by metric, by timestamp) does the scan-and-filter below.

#### Every other lookup is a full scan

```ts
// lib/state/insights.ts:81-84
export function listInsights(sessionId: string): Insight[] {
  const s = state.get(sessionId);
  return s ? [...s.insights.values()] : [];
}
```

Annotation:
  - `state.get(sessionId)` — `O(1)` to find the namespace.
  - `s.insights.values()` — iterator over **all rows**. This is the full table scan.
  - `[...]` — materializes into an array. Now any downstream `.filter()` or `.sort()` walks every row.

When the UI wants "critical insights only," it gets the whole list and filters in React. That's an in-application `WHERE severity = 'critical'` evaluated by JS. With ~12 rows, the planner question is moot.

#### What a secondary index would look like, if we added one

In a real DB:

```sql
-- hypothetical
CREATE INDEX idx_insights_severity ON insights (severity);

-- query
SELECT * FROM insights WHERE severity = 'critical';
-- planner: uses idx_insights_severity, fetches matching row IDs, then heap lookup
```

In this repo, the equivalent would be a *second Map keyed by severity*, maintained in lockstep with the primary Map:

```ts
// hypothetical — not in the codebase
type SessionFeed = {
  insights: Map<string, Insight>;                       // primary index
  insightsBySeverity: Map<Severity, Set<string>>;       // secondary index (set of ids)
};

function putInsight(s: SessionFeed, i: Insight) {
  s.insights.set(i.id, i);
  if (!s.insightsBySeverity.has(i.severity)) {
    s.insightsBySeverity.set(i.severity, new Set());
  }
  s.insightsBySeverity.get(i.severity)!.add(i.id);
}
```

Annotation:
  - The secondary index stores IDs, not row copies. Lookup returns IDs; you then re-hit the primary Map per ID. That's the same shape as a non-covering index in Postgres.
  - The write path now updates two structures atomically. In Postgres, the engine handles index maintenance for you; here, the application would have to.
  - Deletions and updates must mirror across both structures, or the secondary "lies." That's the bug a real engine prevents by making index maintenance part of the storage layer.

We don't do this. The scale doesn't justify it; the maintenance burden would.

#### What a range/sorted access pattern would need

The closest the UI gets to a range scan is "show insights sorted by timestamp" or "show recent insights first." Today that's: `listInsights(...).sort((a, b) => b.timestamp.localeCompare(a.timestamp))`. That's a full materialize + JS sort — `O(n log n)`.

A B+tree index on `timestamp` would let you:
  - read the most recent K without sorting (forward iteration from the right edge)
  - answer `timestamp BETWEEN x AND y` without scanning the whole table
  - serve `ORDER BY timestamp LIMIT 20` from index order, no in-memory sort

There is no equivalent of a B+tree in this repo. `Map` preserves *insertion order*, which is monotonic-ish for timestamps (we insert in arrival order), but it's a fragile contract. The day you re-insert anything out of order, that "implicit index" lies.

#### The TTL cache is also a hash index — and it's the second one in the repo

The `BloomreachDataSource` cache (`lib/data-source/bloomreach-data-source.ts:122`) is the codebase's *other* hash index, this time keyed by `${name}:${JSON.stringify(args)}`:

```ts
// lib/data-source/bloomreach-data-source.ts:122,144-148
private cache = new Map<string, { result: unknown; expiresAt: number }>();
// ...
const cacheKey = `${name}:${JSON.stringify(args)}`;
// ...
const cached = this.cache.get(cacheKey);
if (cached && cached.expiresAt > Date.now()) { ... }
```

This is structurally identical to the primary-key index on `insights`. It's worth naming: every `Map` in the codebase is a hash index of one shape or another. There are exactly **four**: insights, investigations, anomalies, and the response cache. None of them are range-queryable.

### Move 3 — the principle

An index is a contract: "give me this kind of question, I'll answer in this time." Hash indexes promise equality in constant time and refuse to answer anything else. B-trees promise sorted order, which is the basis of every query that says BETWEEN, ORDER BY, or LIMIT-after-sort. Choosing which indexes to maintain IS the database design problem, because every index speeds up reads and slows down writes. This repo has chosen one index per table and pays the scan cost for everything else — which is correct at this dataset size and would be incorrect at any meaningful scale.

## Primary diagram

```
  The complete index inventory of this repo

  ┌─ Map<sessionId, SessionFeed> ────────────────────────────────┐
  │   (hash on sessionId — primary index for the "namespace")     │
  │                                                                 │
  │   ┌─ SessionFeed ─────────────────────────────────────────┐    │
  │   │  Map<insightId, Insight>      HASH INDEX (PK)         │    │
  │   │  Map<insightId, Investigation> HASH INDEX (PK)         │    │
  │   │  Map<insightId, Anomaly>      HASH INDEX (PK)         │    │
  │   └────────────────────────────────────────────────────────┘    │
  └────────────────────────────────────────────────────────────────┘

  ┌─ BloomreachDataSource ────────────────────────────────────────┐
  │   Map<"name:args", {result, expiresAt}>  HASH INDEX (key)      │
  └────────────────────────────────────────────────────────────────┘

  total hash indexes:  4
  total B-tree indexes: 0
  total secondary indexes: 0

  every other access pattern → full scan + JS filter
```

## Elaborate

The B+tree's dominance in databases comes from one fact: disks are good at sequential reads. Sorted index leaves let the engine read a range in one I/O. When your data is in RAM, the I/O argument evaporates — a hash index is just faster for equality. That's why in-memory engines (Redis for KV, DragonflyDB) lean hard on hash tables and only add sorted structures where range queries demand it (Redis sorted sets are a skip list + hash hybrid).

This codebase sits in the in-memory regime. The fact that it has only hash indexes is the *right* default for in-memory. The fact that it has *no* sorted structure is fine because no query in the UI needs one — the UI sorts in JS over a 12-item array.

The day the dataset grows — even to a few thousand persisted briefings — the read-time math flips. `Array.sort` over 5000 entries on every page load is fine; over 50000 it's not; over 500000 it's a page-render bug. The transition point is where you'd add the first real B+tree.

## Interview defense

> Q: "What indexes does this app maintain?"

Verdict: four hash indexes total — three primary-key Maps on the per-session state (insights, investigations, anomalies) and one on the data-source response cache. Zero secondary indexes, zero B-trees. Every non-primary-key lookup is a full scan plus a JavaScript filter.

```
  the index inventory you draw

   Maps in the repo:   insights · investigations · anomalies · response cache
                       ──────────────────────────────────────────────────
                       all four are hash indexes (Map<K, V>)
                       all four answer equality only
```

The load-bearing point: with ~12 insights per briefing, the scan cost is invisible. The shape would have to change in two places at once — adding a real datastore AND seeing access patterns that demand range or non-PK lookup — before secondary indexes earn their weight.

> Q: "Why no B-tree?"

Two reasons compose. First, no on-disk storage means no I/O cost to amortize over sorted leaves. Second, no query in the product wants a range — the UI sorts a small array in JS. The day either of those flips (persisted state + time-range queries on it), a B+tree index on `timestamp` would be the obvious first move.

> Q: "What's the cost of the scan-and-filter pattern?"

`O(n)` per query, where `n` is the number of insights in the session (single-digit to low-double-digit). The cost is in the constant factor of iterating a JS Map and walking a JS filter callback — call it microseconds at this scale. It would matter at 10⁵+ entries; it doesn't here.

## See also

  - [`02-records-pages-and-storage-layout.md`](./02-records-pages-and-storage-layout.md) — the "table" the index sits on
  - [`04-query-planning-and-execution.md`](./04-query-planning-and-execution.md) — what a planner would do with these indexes
  - [`audit.md`](./audit.md) — F1, F6 (why no real index story exists yet)

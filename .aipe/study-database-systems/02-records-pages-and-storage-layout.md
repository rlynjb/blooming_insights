# Records, pages, and storage layout — what a row looks like here

*Industry standard / Project-specific* — there are no pages on disk; instead a row is a JS object inside a per-session `Map`, and the "table" is partitioned by a session-id primary key.

## Zoom out, then zoom in

In a real database the storage layout matters because rows are packed into fixed-size pages, pages live on disk, and locality determines how many disk pages a query has to touch. None of that applies here — rows are heap objects, "pages" are however JavaScript's `Map` lays things out internally, and locality is whatever V8 decides. So the version of this concept that *does* apply is the one about **partitioning**: how is the data sliced so two users don't collide?

```
  Zoom out — where this concept lives

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  InsightCard reads from /api/briefing's stream            │
  └────────────────────────────┬─────────────────────────────┘
                               │  HTTP
  ┌─ Service layer ────────────▼─────────────────────────────┐
  │  putInsights(sid, items)                                  │
  │  listInsights(sid) → ★ THE STORAGE LAYOUT ★                │ ← we are here
  └────────────────────────────┬─────────────────────────────┘
                               │
  ┌─ Storage layer ────────────▼─────────────────────────────┐
  │  state: Map<sessionId, { insights, investigations,        │
  │                          anomalies }>                     │
  │  └─ partitioned per-session                               │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: a "row" is an `Insight` object (see `lib/mcp/types.ts:36`). A "table" is `sessionState(sid).insights`. The primary key is `Insight.id`. The partition key is `sessionId`. The thing worth studying here is the partition — the rest is incidental to the language.

## Structure pass

**Layers:**

```
  L1  state: Map<sessionId, SessionFeed>     ← partition layer
  L2  SessionFeed.insights: Map<id, Insight>  ← table layer
  L3  Insight object                          ← row layer
```

**Axis traced: who can read/write which row?**

```
  Trace one axis: who can read or mutate row R?

  ┌─ L1 outer Map ────────────────────┐
  │  no scope — module global         │   → any code can `state.get(...)`
  └───────────────────────────────────┘
                  (it flips)
  ┌─ L2 SessionFeed ──────────────────┐
  │  scoped to one sessionId          │   → only code with the matching sid
  └───────────────────────────────────┘
                  (it flips)
  ┌─ L3 Insight row ──────────────────┐
  │  scoped to one id within feed     │   → only code with sid AND id
  └───────────────────────────────────┘

  the partition seam is between L1 and L2 — that's the load-bearing one
```

**Seams** — one matters:

- The L1 → L2 boundary is the partition. Cross it without the right `sessionId` and you read someone else's data. Every read/write helper in `lib/state/insights.ts` takes `sessionId` as its first parameter and goes through `sessionState(sid)` — that's the contract.

## How it works

### Move 1 — the mental model

You've built a primary-key lookup before: `users.find(u => u.id === id)`. The shape here is the same, with one extra dimension on top — a partition key that selects which *bucket* of rows to search.

```
  Two-level keying — partition, then primary

  state          (outer Map)
    │
    ├─ sessionId "abc" ──► insights (Map)
    │                        ├─ id "ins-1" → Insight
    │                        └─ id "ins-2" → Insight
    │
    └─ sessionId "def" ──► insights (Map)
                             ├─ id "ins-3" → Insight
                             └─ id "ins-4" → Insight

  lookup(sid, id) = state.get(sid)?.insights.get(id)
  → O(1) outer + O(1) inner
```

That's the kernel. The rest is what the row shape looks like and why the partition matters.

### Move 2 — the layout, one part at a time

#### The outer `Map` (the partition / shard)

```typescript
// lib/state/insights.ts:14
const state = new Map<string, SessionFeed>();

function sessionState(sessionId: string): SessionFeed {
  let s = state.get(sessionId);
  if (!s) {
    s = { insights: new Map(), investigations: new Map(), anomalies: new Map() };
    state.set(sessionId, s);
  }
  return s;
}
```

Every `getInsight`, `putInsight`, `listInsights`, `putInvestigation` goes through `sessionState(sid)`. The function lazily creates a sub-feed on first touch — same shape as auto-creating a partition on first write.

**What breaks if you flatten this to one Map.** The comment at `lib/state/insights.ts:5-7` tells the story: `putInsights` calls `.clear()` to replace the previous briefing. With one shared Map, `clear()` wipes every user's feed mid-briefing. The partition isn't a performance choice; it's a correctness fix.

```
  Why the partition is load-bearing

  WITHOUT partition (one shared Map):
    user A: putInsights(items_A)         insights = items_A
    user B: putInsights([...])           insights.clear() — A's data gone
                                         insights = items_B
    user A: GET /feed                    sees items_B (B's data) ← bug

  WITH partition (outer Map keyed by sid):
    user A: putInsights("sid-A", items_A)   state.get("sid-A").insights = items_A
    user B: putInsights("sid-B", items_B)   state.get("sid-B").insights.clear()
                                            state.get("sid-B").insights = items_B
    user A: GET /feed (sid-A)               state.get("sid-A").insights → items_A ✓
```

#### The inner `Map` (the table)

```typescript
// lib/state/insights.ts:9-12
type SessionFeed = {
  insights: Map<string, Insight>;
  investigations: Map<string, Investigation>;
  anomalies: Map<string, Anomaly>;
};
```

Three sibling tables per session. They don't share keys (insights and investigations use different `id` namespaces — see `Insight.id` vs `Investigation.insightId` at `lib/mcp/types.ts:132-134`). The shape is "all of this user's stuff lives in one struct of typed maps" — the closest the codebase gets to a schema declaration.

#### The row (the Insight)

```typescript
// lib/mcp/types.ts:36-62
export interface Insight {
  id: string;
  timestamp: string;
  severity: Severity;
  headline: string;
  summary: string;
  metric: string;
  change: { value: number; direction: 'up' | 'down'; baseline: string };
  scope: string[];
  source: 'monitoring' | 'query';
  evidence?: { tool: string; result: unknown }[];
  impact?: string;
  // ... business-owner enrichments, all optional
  revenueImpact?: { ... };
  aov?: { ... };
  funnel?: { ... };
  affectedCustomers?: number;
  history?: number[];
  category?: CategoryId;
}
```

Two things to notice about the row shape:

1. **The primary key is `id`** — a `crypto.randomUUID()` minted in `anomalyToInsight` at `lib/state/insights.ts:26`. No surrogate / autoincrement, no composite key — just a UUID.
2. **Most enrichment fields are optional.** The `// new fields stay optional so older snapshots still validate` comment in `.aipe/project/context.md`'s "What must not change" section explains why: the row shape evolves additively because the demo JSON snapshots have to keep validating after the type grows.

That last point is the JSON-snapshot version of schema migration: you cannot rename or remove a field without invalidating committed snapshots, so the schema only grows.

#### The `category` and `coverage` fields — almost a secondary index

`category?: CategoryId` on `Insight` is the closest the codebase gets to a secondary index — it tags each insight with which of the 10 coverage-grid categories it belongs to. Nothing actually indexes by it (there's no `Map<CategoryId, Insight[]>`); the UI just filters on read. But conceptually it's the shape a secondary index would take.

### Move 3 — the principle

When you have no real storage engine, "storage layout" reduces to one decision: **what's the partition key?** Pick wrong (or skip it) and a multi-tenant in-memory store leaks one tenant's writes into another tenant's reads. Pick right (sessionId here) and the lack of any other storage machinery costs nothing for correctness — only durability, which is a separate problem.

## Primary diagram

```
  Storage layout — partitioned in-memory tables

  ┌─ state: Map<sessionId, SessionFeed> ──────────────────────┐
  │                                                            │
  │   key="sess-abc" ──► SessionFeed ─┐                        │
  │   key="sess-def" ──► SessionFeed ─┤                        │
  │   key="sess-xyz" ──► SessionFeed ─┘                        │
  │                                  │                         │
  │                                  ▼                         │
  │              ┌─ SessionFeed ────────────────────────┐      │
  │              │  insights:        Map<id, Insight>    │      │
  │              │  investigations:  Map<id, Inv>        │      │
  │              │  anomalies:       Map<id, Anomaly>    │      │
  │              └───────────────────────────────────────┘      │
  │                                  │                          │
  │                                  ▼                          │
  │              ┌─ Insight (row) ──────────────────────┐      │
  │              │  id (PK), timestamp, severity,       │      │
  │              │  headline, summary, metric,          │      │
  │              │  change{value,direction,baseline},   │      │
  │              │  scope[], source,                    │      │
  │              │  evidence?[], impact?,               │      │
  │              │  + enrichments (all optional)        │      │
  │              └──────────────────────────────────────┘      │
  └────────────────────────────────────────────────────────────┘

  partition key: sessionId       (outer Map)
  primary key:   Insight.id      (inner Map)
  durability:    process-scoped  (dies on restart)
```

## Elaborate

The `_clear(sessionId?: string)` test helper at `lib/state/insights.ts:95-101` makes the partition contract explicit: pass a sid to clear one partition, pass nothing to wipe the whole outer map. Tests using "wipe everything" cannot run against production semantics — they're test-only because they violate the partition.

Compare to a real OLTP database: this is the same pattern as a per-tenant schema in Postgres, or a sharded Redis with `{tenant}:` key prefixes. The difference is that in those systems the partition is enforced at the connection or namespace level; here it's enforced by *convention plus a helper function*. There's nothing physically stopping a buggy caller from writing `state.get('sid-A').insights.set(id, otherSidsInsight)`. The whole correctness story rests on every caller going through `sessionState(sid)`.

If this ever moves to a real store, the partition key becomes a tenant-id column with a row-level security policy or a per-tenant schema. The shape doesn't change; only the enforcement does.

## Interview defense

**Q: How is the in-memory state structured for multi-tenancy?**

Two-level Map: outer keyed by sessionId, inner keyed by the row id. The outer Map is the partition; the inner Map is the table. Helper functions (`sessionState`, `getInsight(sid, id)`, `listInsights(sid)`) enforce that every access goes through the partition.

```
  state ─► sessionId ─► { insights, investigations, anomalies } ─► id ─► row
```

**Q: What's the load-bearing detail in this layout?**

The outer Map. The first version of this code was a module-level `Map<id, Insight>` — `putInsights` called `.clear()` to replace the previous briefing, and that wiped every user's feed on a warm Vercel instance. The fix was to add the outer partition Map and key everything by sessionId. The comment at `lib/state/insights.ts:5-7` explains it.

**Q: What happens if you add a new field to `Insight`?**

It has to be optional, because the committed JSON snapshots in `lib/state/demo-*.json` were captured against the older shape and have to keep validating. The schema grows additively only. That's the migration discipline — there's no `ALTER TABLE`, but there is a "don't break older snapshots" invariant. Adding a required field is a generation failure for the demo replay path.

## See also

- `01-database-systems-map.md` — where this Map sits among the four storage analogs
- `05-transactions-isolation-and-anomalies.md` — the one multi-step write that touches this layout
- `06-locks-mvcc-and-concurrency-control.md` — why the partition makes locks unnecessary
- `09-database-systems-red-flags-audit.md` — what could go wrong with this layout

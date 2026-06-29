# Normalization and duplication

*Denormalization (industry standard) · Language-agnostic*

## Zoom out, then zoom in

Normalization in a SQL database is the rule "one fact, one place." If a customer's email is in the `customers` table, it does not also live on every `order` row — orders point to a customer via `customer_id`. Break that rule and now updating an email means updating every order.

This repo doesn't have rows or foreign keys. But it has the same question: when the same fact appears in two places, *which* is the source of truth, and what makes the duplicate stay in sync?

```
  Zoom out — where duplication shows up

  ┌─ UI layer ──────────────────────────────────────────┐
  │  InsightCard reads insight.affectedCustomers         │
  │  (the duplicated copy — read here for speed)        │
  └────────────────────────┬───────────────────────────┘
                           │
  ┌─ Service layer ────────▼───────────────────────────┐
  │  anomalyToInsight()  copies fields Anomaly→Insight  │
  │  Diagnosis.affectedCustomers → Insight.affectedCustomers │ ← duplicated here
  └────────────────────────┬───────────────────────────┘
                           │
  ┌─ Storage layer ────────▼───────────────────────────┐
  │  ★ THE SOURCES OF TRUTH ★                           │
  │  Anomaly        ← the LLM's raw output (truth #1)   │ ← we are here
  │  Diagnosis      ← the agent's diagnosis (truth #2)  │
  │  Insight        ← derived; carries copies for UI    │
  └─────────────────────────────────────────────────────┘
```

**Zoom in.** Three duplications exist in this codebase. Two are *deliberate denormalization* (the read path can't afford to chase pointers); one is *structural overlap* that comes from having both a raw form and an enriched form of the same fact. None are accidents — but you should be able to name which is which and what would go wrong if they fell out of sync.

## Structure pass

**Layers.** Duplication exists at two altitudes:

- **Within the type layer** — `Anomaly` and `Insight` share four fields (metric, scope, change, severity). This is the "raw form ↔ enriched form" overlap.
- **Across entities** — `Diagnosis.affectedCustomers.count` is copied to `Insight.affectedCustomers`. Two entities, same fact.

**Axis traced — "if this fact changes, who notices?"** That's the canonical normalization question:

```
  Trace the staleness axis across the duplications

  duplication 1: Anomaly ↔ Insight (4 shared fields)
     → metric/scope/change/severity stored on BOTH
     → if Anomaly changes after Insight is derived?
       INSIGHT GOES STALE — and there's no propagation

  duplication 2: Diagnosis.affectedCustomers → Insight.affectedCustomers
     → count denormalized onto Insight for the card
     → if Diagnosis re-runs and count changes?
       INSIGHT GOES STALE unless re-derived

  duplication 3: Anomaly.history → Insight.history
     → 12-week sparkline values copied wholesale
     → same staleness story
```

**Seams.** One boundary does the copying: `anomalyToInsight` in `lib/state/insights.ts:25-45`. **Every denormalization lives at that one function.** If you ever wanted to add a "re-derive insight from anomaly" pass, this is the only file you touch. That's the centralization win — and the reason none of the duplications are accidents.

The other place to look: the JSON snapshot. `lib/state/demo-insights.json` carries the denormalized copies because it *is* the serialized `Insight[]`. So a stale denormalization at write time stays stale forever in the committed snapshot. Covered below.

## How it works

### Move 1 — the mental model

Think of it as "raw form + enriched form" of the same fact. The raw form is what the LLM emits — small, generic, no UI affordances. The enriched form is what the UI reads — bigger, with derived helpers and copied-in fields from related entities. The enriched form is a **read-optimized projection** of everything the UI needs to render one card without joining anything.

```
  The pattern — denormalization as a read-optimized projection

   ┌─ raw form (truth) ─┐         ┌─ enriched form (denormalized) ─┐
   │                     │         │                                  │
   │  Anomaly            │ ──┐     │  Insight                         │
   │  Diagnosis          │   │     │   id, timestamp, headline         │
   │  Recommendation     │   ├───► │   metric, scope, change ← copy    │
   │                     │   │     │   affectedCustomers     ← copy    │
   │                     │   │     │   history               ← copy    │
   └─────────────────────┘   │     └──────────────────────────────────┘
                             │
                  anomalyToInsight()  ← the ONE copy point
```

The cost: if you ever mutate `Anomaly` or `Diagnosis` after building the `Insight`, the copy goes stale. The repo avoids this by **never mutating** — entities are derived once, written once, never patched. Re-running a briefing produces *new* anomalies and *new* insights; nothing is updated in place. That convention is what makes denormalization safe here.

### Move 2 — the three duplications

#### Duplication 1 — `Anomaly` ⊂ `Insight` (the raw→enriched overlap)

Four fields appear on both types: `metric`, `scope`, `change`, `severity`. The Insight type also adds `id`, `timestamp`, `headline`, `summary`, `source`, and the optional enrichments.

```ts
// lib/state/insights.ts:25-45 — anomalyToInsight (the one copy point)
export function anomalyToInsight(a: Anomaly): Insight {
  const id = crypto.randomUUID();
  const sign = a.change.direction === 'down' ? '-' : '+';
  const headline = `${a.scope.join(' ')} ${a.metric} · ${sign}${Math.abs(a.change.value)}%`.toLowerCase();
  return {
    id,
    timestamp: new Date().toISOString(),
    severity: a.severity,                      // ← copy
    headline,
    summary: `${a.metric} ${a.change.direction} ${Math.abs(a.change.value)}% vs ${a.change.baseline}`.toLowerCase(),
    metric: a.metric,                          // ← copy
    change: a.change,                          // ← copy (by reference!)
    scope: a.scope,                            // ← copy (by reference!)
    source: 'monitoring',
    evidence: a.evidence,                      // ← copy
    impact: a.impact,                          // ← copy
    history: a.history,                        // ← copy (by reference!)
    category: a.category,                      // ← copy
    ...deriveInsightFields(a),                 // computed enrichments
  };
}
```

Two things to notice. First, `change`, `scope`, and `history` are **shared references**, not deep copies. If anyone mutates `insight.scope.push(...)`, the underlying `anomaly.scope` mutates too. The repo gets away with this because nothing ever mutates these — but it's a load-bearing convention, not an enforced one. The round-trip test in `test/state/insights.test.ts:104-110` pins this: `expect(anomaly.scope).toBe(sample.scope)` uses `toBe` (reference equality), not `toEqual`.

Second, the **reverse mapping intentionally drops fields**:

```ts
// lib/state/insights.ts:53-55 — insightToAnomaly (drops by design)
export function insightToAnomaly(i: Insight): Anomaly {
  return { metric: i.metric, scope: i.scope, change: i.change, severity: i.severity, evidence: [] };
}
```

This is the call: the diagnostic agent only needs the four core fields to investigate — `evidence` is reset to `[]`, `impact`/`history`/`category` are dropped. The dropped fields are *explicitly tested* (`test/state/insights.test.ts:112-130`) so the next person to add an `Anomaly` field has to make a deliberate decision: include it in the round trip, or pin the drop in a test.

```
  Why the overlap exists — two consumers, two shapes

   ┌─ LLM (writer) ─────┐         ┌─ UI (reader) ────────┐
   │  emits Anomaly     │         │  reads Insight        │
   │  minimal shape     │         │  needs id + headline  │
   │  no id, no headline│         │  + derived helpers    │
   └────────────────────┘         └───────────────────────┘
            │                                ▲
            │                                │
            └────── anomalyToInsight ────────┘
                    bridges the two shapes
```

#### Duplication 2 — `Diagnosis.affectedCustomers.count` → `Insight.affectedCustomers`

This is the **deliberate cross-entity denormalization**. The full fact lives on `Diagnosis`:

```ts
// lib/mcp/types.ts:99
affectedCustomers?: { count: number; segmentDescription: string };
```

A scalar copy of `count` lives on `Insight`:

```ts
// lib/mcp/types.ts:58
affectedCustomers?: number; // denormalized from Diagnosis.affectedCustomers.count
```

The comment on the Insight field tells you it's a copy, and tells you the source.

**Why duplicate.** The feed renders `InsightCard`s — one per anomaly. Each card wants to show "affects ~3,400 customers" without loading the full `Investigation` (which is a multi-KB tree of reasoning + recommendations). The denormalization saves the join: the card reads `insight.affectedCustomers` directly.

**What keeps it consistent.** Nothing automatic. The denormalization is populated when the agent loop produces the Diagnosis and writes the Insight together. There's no "if Diagnosis re-runs, update Insight" wire. If a re-run produced a different count, the Insight's copy would be stale until the *next* briefing rebuilt the feed.

```
  Cross-entity denormalization — affectedCustomers

  ┌─ Diagnosis ──────────────────────────┐
  │  affectedCustomers: {                │
  │    count: 3400,           ◄── truth  │
  │    segmentDescription: "..."         │
  │  }                                    │
  └──────────────────┬───────────────────┘
                     │  copy on write
                     ▼
  ┌─ Insight ────────────────────────────┐
  │  affectedCustomers: 3400  ◄── copy   │
  │  (scalar only — segmentDescription   │
  │   stays on Diagnosis)                │
  └──────────────────────────────────────┘
       ▲
       │ what the card reads (one map lookup, no join)
```

The cost: if you displayed `affectedCustomers` on the card AND `segmentDescription` somewhere on the same card, you'd be joining two entities to render one tile — and the denormalization buys you nothing. Today the card reads only the count, so the copy pays for itself.

#### Duplication 3 — `Anomaly.history[]` → `Insight.history[]`

The 12-week sparkline values. Same shape on both, copied by reference at `anomalyToInsight`. The reason it's on `Anomaly` at all is that the LLM emits it (the agent looks at historical data when ranking severity), and the reason it's on `Insight` is that the card renders the sparkline.

This one is the most defensible duplication: the LLM emits it once, and the *only* reader is the UI. The "raw" form of `Anomaly.history` is never read by anything except the immediate translation to `Insight`. You could move it to `Insight`-only and drop it from `Anomaly`, but then you'd lose the round-trip property (`insightToAnomaly` would have to reconstruct it from nothing). The repo prefers "carry it on both, drop on the way back" because the round trip is the operative invariant.

### Move 2 variant — the load-bearing skeleton

The denormalization skeleton has three parts. Strip any one and a real capability breaks:

1. **The single copy point (`anomalyToInsight`).** Drop this and denormalization is scattered — every call site that builds an Insight has to remember to copy `affectedCustomers`, and the next field added gets forgotten in half of them. The function is the *forcing function* for "every Insight has the same denormalized shape."

2. **The "never mutate" convention.** Drop this and the shared references between `Anomaly.scope` and `Insight.scope` (same array, two entities) become a bug factory. The convention is what makes copy-by-reference safe.

3. **The optional fields on the denormalized copies.** Drop this and old demo snapshots stop validating the moment you add a new denormalized field — because the copy on the snapshotted Insight wouldn't exist yet. Every denormalized field has to be `?`. Covered in `05`.

Hardening on top: `deriveInsightFields(a)` (`lib/insights/derive.ts:27-39`) is the second layer of denormalization — it derives `revenueImpact.lostUsd` and `revenueImpact.expectedUsd` from `anomaly.evidence`. That's a *computed* denormalization (the fact is derived, not just copied), and it's also optional so old snapshots stay valid.

### Move 3 — the principle

Denormalization is information leakage you've decided to live with — *not* a bug, *as long as you can name who pays for the staleness.* In a database, the answer is usually "the writer pays — every UPDATE has to propagate." Here, the answer is "the writer pays once, and we promise no in-place updates." That promise is the whole reason the duplications are safe. Lose the promise and the duplications become rot.

## Primary diagram

The full denormalization map, with every copied field and every source-of-truth pointer.

```
  Denormalization map — three duplications, one copy point

  ┌─ truth (raw entities) ──────────────────────────────────────────────┐
  │                                                                      │
  │   Anomaly                          Diagnosis                         │
  │   ┌─────────────────┐              ┌──────────────────────────────┐  │
  │   │ metric          │              │ conclusion                   │  │
  │   │ scope[]         │              │ evidence[]                   │  │
  │   │ change          │              │ hypothesesConsidered[]       │  │
  │   │ severity        │              │ affectedCustomers: {         │  │
  │   │ evidence[]      │              │   count,                     │  │
  │   │ impact          │              │   segmentDescription         │  │
  │   │ history[]       │              │ }                            │  │
  │   │ category        │              └────────────┬─────────────────┘  │
  │   └────────┬────────┘                           │                    │
  │            │                                    │                    │
  └────────────┼────────────────────────────────────┼────────────────────┘
               │ copy at anomalyToInsight()         │ copy by agent loop
               │                                    │ (count only)
               ▼                                    ▼
  ┌─ denormalized projection (Insight) ─────────────────────────────────┐
  │                                                                      │
  │   id              ← stamped here, not copied                         │
  │   timestamp       ← stamped here, not copied                         │
  │   headline        ← derived: scope+metric+sign+value                 │
  │   summary         ← derived: metric+direction+value+baseline         │
  │   source          ← constant 'monitoring'                            │
  │   metric          ← COPY from Anomaly                                │
  │   scope[]         ← COPY (shared ref) from Anomaly                   │
  │   change          ← COPY (shared ref) from Anomaly                   │
  │   severity        ← COPY from Anomaly                                │
  │   evidence[]      ← COPY from Anomaly                                │
  │   impact          ← COPY from Anomaly                                │
  │   history[]       ← COPY (shared ref) from Anomaly                   │
  │   category        ← COPY from Anomaly                                │
  │   affectedCustomers   ← COPY of Diagnosis.affectedCustomers.count    │
  │   revenueImpact       ← DERIVED from anomaly.evidence (lib/insights) │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘

  Read pattern: feed renders 5 InsightCards, one map lookup each,
                zero joins, zero post-processing.
```

## Elaborate

The information-hiding analogy from `study-software-design.md` translates directly: **a denormalized field on `Insight` is information leakage from `Diagnosis` into `Insight`'s contract.** The `Insight` type "knows" that `affectedCustomers` is a scalar number — which only makes sense if you also know `Diagnosis` carries the rich form. Two entities now share a fact, and a contract change to `Diagnosis.affectedCustomers` (say, adding a confidence interval) means deciding whether `Insight.affectedCustomers` follows.

The settled industry framing here is **read-optimized projection** (sometimes called a "materialized view" when persisted, a "view model" in MVC, or a "DTO" in service-oriented work). All three names point at the same move: build a flat, query-shaped representation of nested truth, accept the staleness cost, win the read-path simplicity. The choice is always paid for by either (a) accepting staleness, (b) wiring write-time propagation, or (c) re-deriving on every read. This codebase picks (a) — and bounds the cost by promising no in-place updates.

A SQL contrast worth holding: in a `customers/orders/order_items` schema, you'd normally store `order_item.unit_price` even though `unit_price` lives on `products` — because the price at the time of sale must be frozen, even when the product's current price changes later. That's denormalization-for-history. The denormalizations here are denormalization-for-read-speed; nothing is being frozen, the source could be re-read, but the join would cost more than the duplication. Same shape, different motive.

## Interview defense

**Q: Walk me through the duplications and what keeps them consistent.**

> Three duplications. The biggest is `Insight` carrying the four core fields from `Anomaly` (metric/scope/change/severity) — that's raw-form-versus-enriched-form, not really denormalization. The two real denormalizations are: `Diagnosis.affectedCustomers.count` copied to `Insight.affectedCustomers` (a scalar — saves the card from joining the full Investigation tree), and `Anomaly.history` copied to `Insight.history` (the sparkline values).
>
> What keeps them consistent is the convention "entities are never mutated in place" — re-running a briefing produces *new* anomalies and *new* insights, not patched ones. Combined with a single copy point in `anomalyToInsight` (`lib/state/insights.ts:25-45`), denormalization is safe because every Insight is built from scratch.

```
   the three duplications and the one copy point

           Anomaly ──┐
                     ├──► anomalyToInsight ──► Insight (denormalized)
        Diagnosis ──┘
        (count only)
```

**Q: When would these duplications become a problem?**

> The moment you allow in-place updates. If a user could edit an Insight (say, dismiss it, or annotate it), the copies of fields from Anomaly stay correct because Anomaly is immutable too. But if you re-ran a Diagnosis on an existing Insight and didn't rebuild the Insight, the denormalized `affectedCustomers` count would drift. The signal it's drifting is that the `EvidencePanel` (which reads from Diagnosis) and the `InsightCard` (which reads from Insight) show different numbers for the same insight.
>
> The fix would be either (a) re-derive `Insight.affectedCustomers` after every Diagnosis write, or (b) drop the denormalization and pay the join. Today neither is needed because investigations are saved-then-replayed, not edited.

**Q: Why is `change` a shared reference instead of a deep copy?**

> Performance — it's a `Map`-set per insight in a hot loop, and the convention is never-mutate, so the copy buys nothing. The test that pins it (`test/state/insights.test.ts:106-110`) uses `toBe` instead of `toEqual` to make the reference-equality contract visible. If the convention ever broke — say, someone called `insight.scope.push(...)` to add a derived scope tag — the underlying Anomaly would mutate too, and a later round trip through `insightToAnomaly` would carry the mutation back. The risk is real but bounded; the test is the alarm bell.

```
   shared reference between Anomaly.scope and Insight.scope

   Anomaly.scope ──►┐
                    ├── SAME ARRAY in memory
   Insight.scope ──►┘

   safe BECAUSE nothing ever mutates either side
```

## See also

- `01-the-data-model-and-its-shape.md` — the entity types in full.
- `04-transactions-and-integrity.md` — the type guards that protect the LLM↔system boundary where these copies originate.
- `05-migrations-and-evolution.md` — why the denormalized fields are all optional, and what that buys for the snapshot.

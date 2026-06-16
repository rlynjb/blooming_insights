# blooming insights — data modeling audit (typed schemas + a real relational store)

> The shape question: **does the data's shape match how it's actually read and written — and can it stay correct?** Most data-modeling guides anchor on a relational schema with migrations, FKs, and indexes. This repo now has **two persistence regimes side by side**. (1) The TypeScript interfaces in `lib/mcp/types.ts` are the contract every agent crosses — schemas-as-types, integrity-by-runtime-guard at the LLM seam. (2) The Phase 2 authored MCP server (`mcp-server-olist/`) has a **real SQLite relational schema** — `customers`, `orders`, `order_items`, `products`, `payments`, `reviews`, `seeded_anomalies` — with FKs, indexes, NOT NULL constraints, `foreign_keys=ON`, and `journal_mode=WAL`. Two domains, one `WorkspaceSchema` interface bridges them.

## The verdict, up front

The typed-schema work is **strong**. `lib/mcp/types.ts` carries 8 interfaces that pin every shape the four agents pass between each other — `Insight`, `Anomaly`, `Diagnosis`, `Recommendation`, `CoverageReport`, `ToolCall`, `ReasoningStep`, `Investigation`. The compiler enforces the shape across module boundaries. The runtime guards (`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`) re-enforce it at the **LLM seam** — the one boundary where TypeScript can't see (the model emits JSON-as-string).

The **Phase 2 Olist DB is also strong**. Real relational schema (7 tables), FKs with `foreign_keys=ON`, 9 indexes mapped to the access paths each tool actually issues, NOT NULL on every load-bearing column, `journal_mode=WAL` for concurrent reads. The schema was **designed against the tool queries that read it** — the `idx_orders_purchase_ts` index supports the time-bucket aggregation in `get_metric_timeseries`; the per-dimension indexes (`idx_customers_state`, `idx_products_category`, `idx_payments_type`) support `get_segments` and the dimension joins. The buildable target file 06 named a year ago has shipped — for the synthetic dataset.

The leaks live elsewhere — and one of them just got fixed. The original **Insight ↔ Anomaly field-copy list** finding (encoded in three places, the round-trip silently dropping four fields) has been **partially retired**: `insightToAnomaly` is now colocated with `anomalyToInsight` in `lib/state/insights.ts`, a doc comment names the deliberate drop, and `test/state/insights.test.ts` carries the round-trip. The wire-format and route-side conversion still exist, but the schema is no longer the smell — the wire format is. File 02 carries the updated story.

The **new top finding is data-modeling-meets-LLM-evals: BRL stored as integer cents under a column literally named `price_brl`**. The agent in Phase 3 evals consistently narrated the integer 131,965,000 as R$131,965 instead of R$1,319,650 — a textbook "unit-in-column-name vs unit-in-storage" failure, with measured downstream cost in the recommendation judge's `impact_sized` score. New file 10 covers it.

```
  the audit at a glance (2026-06-16)

  ┌─ typed schema (the agent contract) ─────────────┐
  │  lib/mcp/types.ts        ★ STRONG — one source  │
  │  lib/mcp/validate.ts     ★ STRONG — runtime guard│
  │  lib/mcp/schema.ts       ★ STRONG — both bootstraps│
  │  lib/agents/categories.ts ★ STRONG — capability gate│
  └─────────────────────────────────────────────────┘
                       │
                       │  now sits next to…
                       ▼
  ┌─ relational schema (Olist, mcp-server-olist/) ──┐
  │  ★ STRONG — FK + indexes + NOT NULL + WAL       │
  │  customers · orders · order_items · products ·  │
  │  payments · reviews · seeded_anomalies          │
  │  data horizon: 2025-12-01 → 2026-06-01 (182d)   │
  │  mulberry32(seed=42) — byte-identical every run │
  └─────────────────────────────────────────────────┘
                       │
                       │  with one real schema-design bug
                       ▼
  ┌─ unit-in-name failure (measured downstream cost)┐
  │  price_brl stored as integer CENTS              │ ← new top finding
  │  agents narrate cents as Reais → impact_sized=0 │   (see file 10)
  └─────────────────────────────────────────────────┘
                       │
                       │  and the original leak, now partly retired
                       ▼
  ┌─ shape leaks (same fact, two places) ──────────┐
  │  insightToAnomaly now colocated + round-trip    │ ← FIXED in code
  │    test in test/state/insights.test.ts          │
  │  wire-format-as-state still drops 4 fields      │ ← still real
  │  Recommendation defined TWICE in the spec       │
  │  (resolved by a "use the richer one" comment)   │
  └─────────────────────────────────────────────────┘
                       │
                       │  topics that ACTIVATED with the Olist DB
                       ▼
  ┌─ now exercised (was "not yet" in 2026-06-01) ──┐
  │  normalization        — Olist is 3NF + FKs      │
  │  indexes vs queries   — 9 indexes; queries fit  │
  │  transactions         — WAL + foreign_keys ON   │
  │  constraints          — NOT NULL everywhere     │
  │  ground-truth records — seeded_anomalies table  │
  └─────────────────────────────────────────────────┘
                       │
                       │  still not exercised
                       ▼
  ┌─ honest gaps remaining ────────────────────────┐
  │  migrations under live data (seed re-runs from  │
  │    scratch — no ALTER TABLE story)              │
  │  multi-writer concurrency on shared rows        │
  │    (read-only at runtime, single seeder)        │
  └─────────────────────────────────────────────────┘
```

## What "data modeling" means in this repo

The spec asks for schema shape, normalization, indexes-vs-queries, integrity, migrations, and access patterns. **As of 2026-06-16, most of those apply for real** — the Phase 2 Olist DB activated the topics that were "not yet exercised" in the original audit. The honest read:

- **Schema shape** → applies twice. The 8 interfaces in `lib/mcp/types.ts` ARE the agent-contract schema. The 7 tables in `mcp-server-olist/scripts/seed-olist.ts` (`SCHEMA_SQL`) ARE a real relational schema. File 01 walks both; new file 08 zooms into the Olist DB.
- **Normalization** → applies for real now. Olist is properly 3NF: `customers` owns location, `products` owns category/weight, `orders` references both, `order_items` is the M:N bridge with the price. The lesson from the typed-schema layer (the `Insight↔Anomaly` field-copy that file 02 audits) sits next to a textbook normalization in file 08.
- **Indexes vs queries** → applies for real now. The 9 indexes in `SCHEMA_SQL` map to the access paths the three Olist tools issue (file 03 walks them). The Bloomreach EQL recipes are still there as the cousin pattern for the rate-limited upstream.
- **Integrity** → applies on two layers. DB-side: FKs (`order_items.order_id → orders(id)`, etc.), NOT NULL on every load-bearing column, `pragma foreign_keys = ON`, `pragma journal_mode = WAL`. App-side: TypeScript at module boundaries + three guards in `validate.ts` at the LLM seam + per-session sub-maps in `lib/state/insights.ts` (now session-scoped — see file 04).
- **Migrations** → still not yet exercised for live data. The Olist seeder REBUILDS the DB from scratch on every `npm run seed` run; there's no `ALTER TABLE` story, no rollback. Determinism (`mulberry32(seed=42)`) makes "drop + reseed" safe instead of needing migrations — that's the design choice, not a gap. File 05 walks both sides.
- **Access patterns + storage choice** → applies. Three layers now: the in-memory per-session `Map`s for the briefing UI, the on-disk SQLite for the Olist analytics, and the committed `demo-*.json` seeds for offline UI replay. File 06 walks the three.
- **Ground-truth records modeled IN the data** → new. The `seeded_anomalies` table is the eval contract — Phase 3 evals (`eval/scripts/run-detection.ts`) read it to compute precision/recall against the monitoring agent's output. File 09 covers this.
- **Determinism in test data** → new. `mulberry32(seed=42)` makes the dataset byte-identical across machines. File 09 covers the pattern.
- **Units in column names** → new top finding. `price_brl` reads as "BRL the currency" but stores integer cents. Agents narrate it as Reais, the recommendation judge's `impact_sized` collapses to 0. File 10.

## The schema diagram — what the model looks like

Two persistence layers now sit side by side. The **agent contract** layer (`lib/mcp/types.ts` interfaces, in-memory per-session `Map`s) holds the live UI state. The **Olist DB** layer (SQLite, 7 tables) holds the analytics substrate the Phase 3 evals run against. Both are owned by the repo; the Bloomreach upstream remains read-only at this layer.

The entity diagram below shows both, with the `WorkspaceSchema` interface as the duck-typed bridge — same shape, two derivations (`bloomreachWorkspaceSchema()` and `olistWorkspaceSchema()`). Note the direction of the dashed arrow on the agent side: `Insight` is the **enriched view** of `Anomaly`, not its parent. The mapping is one-way at write-time and lossy at read-time (the wire-format leak — see file 02).

```
  the model — both layers, side by side

  ┌─ AGENT CONTRACT (typed interfaces; in-memory) ───────────────┐
  │                                                                │
  │  WorkspaceSchema  (one interface, two derivations)             │
  │   ├ bloomreachWorkspaceSchema(...)  from MCP introspection     │
  │   └ olistWorkspaceSchema()          hand-derived from db.ts    │
  │                          │                                     │
  │                          │ schemaCapabilities() / dataHorizon  │
  │                          ▼                                     │
  │  ┌─ Anomaly ────┐ ──anomalyToInsight──► ┌─ Insight ────────┐  │
  │  │ metric       │  8 copied + 5 derived │ id (uuid PK)     │  │
  │  │ scope[]      │ ◄─insightToAnomaly──  │ timestamp        │  │
  │  │ change       │  4 copied, 4 DROPPED  │ + Anomaly fields │  │
  │  │ severity     │  (now colocated +     │ + 6 derived T1   │  │
  │  │ evidence     │   round-trip tested)  │   enrichments    │  │
  │  │ impact?      │                       └────────┬─────────┘  │
  │  │ history?     │                                │            │
  │  │ category?    │                                ▼            │
  │  └──────────────┘            Map<sessionId, SessionFeed>      │
  │                                  ├ insights:      Map<id, I>  │
  │                                  ├ anomalies:     Map<id, A>  │
  │                                  └ investigations:Map<iid, V> │
  │                              (session-scoped — multi-user)    │
  └──────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ wire format ?insight=<JSON>
                                  │ still drops 4 fields (file 02)
                                  │
  ┌─ OLIST RELATIONAL SCHEMA (SQLite, mcp-server-olist/) ────────┐
  │                                                                │
  │  customers (id PK, state, city)                                │
  │    │  idx_customers_state                                       │
  │    │ FK from orders.customer_id                                 │
  │    ▼                                                            │
  │  orders (id PK, customer_id FK, status, purchase_ts, delivered_ts)│
  │    │ idx_orders_purchase_ts, idx_orders_customer                │
  │    │ FK from items / payments / reviews                         │
  │    ▼                                                            │
  │  order_items (order_id FK, product_id FK, price_brl, freight_brl)│
  │    │ idx_items_order, idx_items_product                          │
  │    │ ★ price_brl is INTEGER CENTS — name lies (file 10)         │
  │                                                                │
  │  products (id PK, category, weight_g)  idx_products_category    │
  │  payments (order_id FK, type, installments, value_brl)          │
  │                                          idx_payments_order/type│
  │  reviews  (order_id FK, score, ts)       idx_reviews_order      │
  │                                                                │
  │  seeded_anomalies (id PK, metric, dimension, segment,           │
  │                    start_ts, end_ts, expected_severity, desc)   │
  │    ★ GROUND TRUTH for Phase 3 evals (file 09)                  │
  │                                                                │
  │  PRAGMA foreign_keys = ON · journal_mode = WAL                  │
  │  seeded by mulberry32(seed=42) → byte-identical every run       │
  │  6-month horizon: 2025-12-01 → 2026-06-01 (182 days)            │
  └──────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ get_metric_timeseries / get_segments /
                                  │ get_anomaly_context (the 3 Olist tools)
                                  │
  ┌─ EVAL RESULT SCHEMAS (eval/) ────────────────────────────────┐
  │  fixtures/reference-*.json          golden answers (calibration)│
  │  fixtures/regression-golden/01..10.json  captured-shape goldens │
  │  results/<YYYY-MM-DD>/*.json        per-day run + judge scores  │
  │  ★ result shapes ARE a data contract (file 09)                  │
  └──────────────────────────────────────────────────────────────┘
```

The original **Insight ↔ Anomaly leak** has been **partially retired in code**: `insightToAnomaly` is now colocated with `anomalyToInsight` in `lib/state/insights.ts` (L25–L55), a doc comment names the four fields it deliberately drops (`evidence`, `impact`, `history`, `category`), and the round-trip is tested in `test/state/insights.test.ts`. The drop itself is still real — it's now an explicit design choice, not an oversight — and the same wire-format path in the route still relies on it. File 02 carries the updated framing: same shape, two layers of duplication, one of them now documented and tested.

## How to read this guide

Ten files, dependency order:

```
  .aipe/study-data-modeling/
    README.md                                 (you are here — both layers + the units bug)
    01-the-data-model-and-its-shape.md        the 8 interfaces + WorkspaceSchema dual derivation
    02-normalization-and-duplication.md       the Insight↔Anomaly story (now partly fixed)
    03-indexing-vs-query-patterns.md          the 9 Olist indexes vs the 3 tool queries
    04-transactions-and-integrity.md          DB integrity (FK/WAL) + agent-contract guards
    05-migrations-and-evolution.md            git-evolves-types + seed-rebuilds-DB
    06-access-patterns-and-storage-choice.md  three storage layers, three durability stories
    07-data-modeling-red-flags-audit.md       capstone — what's still real after the activations
    08-the-olist-relational-schema.md         the second domain: 7 tables, 3NF, designed-against-queries
    09-deterministic-synthetic-data.md        mulberry32 + seeded_anomalies + eval result shapes
    10-units-in-column-names.md               price_brl is cents — measured downstream cost
```

## The top three calls, ranked

1. **Rename `price_brl` to `price_brl_cents` (or store as decimal+currency).** The agent reads the column literally — its training data treats `_brl` as "Brazilian Reais." A name that includes the storage unit (`price_brl_cents` or `price_centavos`) prevents the bug that today hands the recommendation judge an `impact_sized=0` score. The eval comparison file (`eval/results/2026-06-15-after-fix/summary.md`) shows the cost is real and measurable. File 10 walks the fix.

2. **Retire the wire-format round-trip (`?insight=<JSON>` → `insightToAnomaly`).** The original "field-copy in 3 files" finding is half-fixed: the conversion is colocated, documented, and tested — but the wire format still SHIPS the full Insight JSON in the URL and the route still drops 4 fields converting it back. Switching to `?insight=<id>` plus a per-session lookup retires the drop entirely; the session-scoped Map already makes the lookup safe. File 02 walks the next move.

3. **Decide what `seeded_anomalies` is a contract WITH.** Today the table is read by `eval/scripts/run-detection.ts` to grade the monitoring agent — that's the eval contract. But the multiplier columns (`_generator.value` in the seed source) are NOT in the DB; they live only in the seed script. If a future change to `seed-olist.ts` tweaks a multiplier without updating the `description` field in `seeded_anomalies`, the eval still passes against the stale description. The integrity rule is "the multiplier is the ground truth; the description is the documentation"; today nothing enforces alignment. File 09 names it.

## What this guide does NOT find

This repo's **runtime UI state still has no relational store** — the per-session `Map`s in `lib/state/insights.ts` are still the briefing store, lost on Vercel cold start, bridged by the wire-format-as-state pattern (file 06). The buildable target named in the 2026-06-01 version — a Postgres/SQLite for `insights`/`investigations` — has shipped only as a synthetic analytics warehouse (Olist), not as durable UI state. The runtime gap remains.

The Olist DB also doesn't exercise **live-data migrations** — every `npm run seed` drops the file and rebuilds from scratch. That's intentional (the determinism in file 09 depends on it) but it means "how do you ALTER TABLE under live writers" is still not a question this codebase has answered. When that becomes a real requirement (e.g. if the UI starts persisting briefings to a real DB), the answer would be Drizzle + `drizzle/` migration files, exactly the pattern AdvntrCue uses.

---
Updated: 2026-06-16 — added the Olist relational layer + units-in-name finding + leak fix; 7 → 10 files.

# The Olist relational schema

> **RETIRED 2026-06-18.** This file was authored against the Olist MCP
> server / Phase 3 eval pipeline, both removed from the codebase. The
> patterns it teaches are real, but the code anchors it cites no longer
> exist. Preserved as a historical record of what was studied.
>
> **What replaced this:** nothing. There is no relational schema in this
> repo today. The patterns this file teaches (3NF, designed-against-queries
> indexing, FK + WAL + NOT NULL as the integrity stack) are still real,
> but they're not anchored anywhere in `blooming_insights` anymore.
> The closest cousin in the current repo is the in-process synthetic
> fixture (file 11) — same "data is owned by the repo" intent, but no
> tables, no joins, no FKs, no indexes.

**Industry name(s):** Relational schema · 3NF · entity-relationship model · transactional schema · designed-against-queries
**Type:** Industry standard · Language-agnostic · Project-specific (the Phase 2 authored MCP server)

> The second persistence layer. The Olist domain is a Brazilian-e-commerce schema modeled in `mcp-server-olist/scripts/seed-olist.ts` (the `SCHEMA_SQL` constant) — 7 tables, 9 indexes, FKs across the joins, `NOT NULL` on every load-bearing column, `PRAGMA foreign_keys = ON`, `journal_mode = WAL`. The schema was designed against the three Olist tools (`get_metric_timeseries`, `get_segments`, `get_anomaly_context`) — every column, every index, every constraint can be pointed back to a specific access path it supports. This file walks the schema as a worked example of "design the schema against the queries you're going to ask of it."

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** The Olist DB sits inside the `mcp-server-olist/` package as a SQLite file on disk (`data/olist.db`). The seeder writes it; three tools read it; nothing else owns it. The blooming insights agent loop reaches it via MCP — when `LiveMode === 'live-sql'`, the data source spawns an `mcp-server-olist` subprocess and calls its tools.

```
  Zoom out — where the Olist schema lives

  ┌─ Agent loop band ────────────────────────────────────────┐
  │  monitoring / diagnostic / recommendation agents          │
  │  see the same MCP interface as the Bloomreach path        │
  └──────────────────────────┬───────────────────────────────┘
                             │ tool: get_metric_timeseries / ...
  ┌─ MCP transport ──────────▼───────────────────────────────┐
  │  stdio subprocess: mcp-server-olist                       │
  └──────────────────────────┬───────────────────────────────┘
                             │ better-sqlite3 prepared statement
  ┌─ Olist tool layer ───────▼───────────────────────────────┐
  │  get_metric_timeseries.ts                                 │
  │  get_segments.ts                                          │
  │  get_anomaly_context.ts                                   │
  │  each tool composes a SQL query from the input JSON       │
  └──────────────────────────┬───────────────────────────────┘
                             │ SQL execution
  ┌─ SQLite ─────────────────▼───────────────────────────────┐
  │  data/olist.db    ← the schema, indexes, data, pragmas    │
  │  7 tables · 9 indexes · FK enforcement · WAL durability   │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this concept answers: when you have three known access patterns and one synthetic dataset to ship, what does the schema look like? The Olist schema is the answer: 3NF, FKs covering the joins, NOT NULL covering the invariants, indexes covering the predicates the tools issue. Nothing speculative; nothing missing.

---

## Structure pass

**Layers.** Schema layer + tool layer + agent layer. The schema is designed against the tool layer's queries; the tool layer is designed against the agent's information needs.

**Axis: column-justified-by-query.** For each column, which tool query needs it? This is the right axis because schema design is *literally* about justifying every column against a use. Tables that have unused columns are over-modeled; columns that come up in multiple queries earn their NOT NULL.

**Seams.** Three matter. **S1: data ↔ tool.** Every tool reads through a prepared statement; the schema's column types match the SQL the tool issues. **S2: tool ↔ agent.** Every tool's output JSON is the agent's only view of the data; the column-to-output projection lives in the tool. **S3: seed-time ↔ runtime.** The seeder writes (one path); the tools read (three paths). Schema constraints are enforced on the write side; query plans are exercised on the read side.

```
  Structure pass — design-against-queries

  ┌─ 1. LAYERS ──────────────────────────────────────────────┐
  │  Schema (SCHEMA_SQL) · Tools (3 files) · Agents (above)   │
  └─────────────────────────────┬────────────────────────────┘
                                │  pick the axis
  ┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
  │  column-justified-by-query: which tool needs this column? │
  │  every column has at least one named consumer             │
  └─────────────────────────────┬────────────────────────────┘
                                │  trace across seams
  ┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
  │  S1: data ↔ tool         ★ prepared stmts; type-matched  │
  │  S2: tool ↔ agent        ★ projection lives in tool      │
  │  S3: seed-time ↔ runtime ★ write-once, read-many; WAL    │
  └─────────────────────────────┬────────────────────────────┘
                                ▼
                        Block 4 — How it works
```

---

## How it works

### Move 1 — the entity-relationship picture

You know how a SQL textbook draws an e-commerce ER diagram with `customers`, `orders`, `products`, an order-items bridge, and payments/reviews hanging off orders? That's literally what this schema is. Brazilian variant: states + cities for `customers`, BRL for prices, payment types include `voucher` and `boleto`. The synthetic dataset stays close to the real Olist Kaggle dataset's shape so the agent's training data on "Brazilian e-commerce" is recognizable.

```
  the schema — entities and relations

       ┌─ customers ─────────────┐
       │ id PK · state · city     │ idx_customers_state
       └─────────┬────────────────┘
                 │ FK customer_id
                 ▼
       ┌─ orders ────────────────────────────┐
       │ id PK · customer_id FK · status      │ idx_orders_purchase_ts
       │ purchase_ts · delivered_ts           │ idx_orders_customer
       └──┬──────────────────────┬──────────┬┘
          │ FK order_id          │ FK       │ FK
          ▼                      ▼          ▼
   ┌─ order_items ───┐  ┌─ payments ──────┐ ┌─ reviews ──┐
   │ order_id FK     │  │ order_id FK     │ │ order_id FK │
   │ product_id FK   │  │ type · install. │ │ score · ts  │
   │ price_brl ★cents│  │ value_brl ★cents│ │             │
   │ freight_brl     │  └──┬──────────────┘ └─────────────┘
   └────┬────────────┘    idx_payments_order
        │ FK product_id   idx_payments_type
        ▼
   ┌─ products ─────────┐
   │ id PK · category   │ idx_products_category
   │ weight_g           │
   └────────────────────┘

   ┌─ seeded_anomalies ─────────────────────────────────┐
   │ id PK · metric · dimension · segment                │  NOT a join target.
   │ start_ts · end_ts · expected_severity · description │  Ground-truth records
   │                                                      │  for Phase 3 evals.
   │ ★ multiplier value lives ONLY in SEEDED_ANOMALIES   │  See file 09.
   │   constant — drift risk; see audit #4.              │
   └─────────────────────────────────────────────────────┘

   ★ price_brl, freight_brl, value_brl: stored as INTEGER cents.
      column name says "brl" → agents read it as Reais (file 10).
```

### Move 2 — the seven tables, one at a time

#### `customers` — the simplest entity

3 columns. `id` PK, `state TEXT NOT NULL`, `city TEXT NOT NULL`. The state is one of the 27 Brazilian state codes (`SP`, `RJ`, `MG`, ...), weighted toward `SP/RJ/MG` to match the real Olist distribution. The `idx_customers_state` index supports every "filter or group by state" query — including the SP-revenue-drop seeded anomaly's detection path.

**What breaks if `state` were nullable:** the agent's segment queries (`get_segments(dimension='state')`) would have to handle NULL as a segment value; the result set would include a "no segment" bucket the agent would have to either filter or explain. NOT NULL forces the invariant "every customer has a known state" — which the seeder produces by construction.

#### `products` — second simplest

3 columns. `id` PK, `category TEXT NOT NULL`, `weight_g INTEGER NOT NULL`. Categories are a closed enum at seed time (7 values: `electronics`, `fashion`, `home_decor`, `health_beauty`, `sports`, `toys`, `food_drink`). The category is the dimension behind the electronics-spike seeded anomaly. `idx_products_category` supports the dimension joins.

**`weight_g` is interesting** — no current tool reads it. It's there because real Olist data has it (freight modeling uses it). The schema includes it for fidelity to the real dataset; the tools don't need it yet. **This is the only speculative column in the schema** — every other column has a named consumer.

#### `orders` — the central fact table

5 columns. `id` PK, `customer_id FK NOT NULL`, `status TEXT NOT NULL`, `purchase_ts INTEGER NOT NULL`, `delivered_ts INTEGER` (nullable — pending orders haven't been delivered). The `purchase_ts` is unix epoch seconds; the `idx_orders_purchase_ts` index is the most-used index in the DB (every time-bucketed aggregation hits it).

**Why `purchase_ts` is INTEGER and not TIMESTAMP:** SQLite doesn't have a native timestamp type; storing as integer epoch is the conventional choice. The `db.ts` helpers (`isoDateToEpoch`, `epochToIsoDate`, `truncateEpoch`) handle the conversion at the seam. The agent never sees epochs — it sees ISO date strings — because each tool projects through the helpers on output.

#### `order_items` — the M:N bridge

4 columns. `order_id FK NOT NULL`, `product_id FK NOT NULL`, `price_brl INTEGER NOT NULL`, `freight_brl INTEGER NOT NULL`. **No primary key** — multiple rows per `(order_id, product_id)` are allowed (an order can have two of the same product as separate line items). The bridge is the textbook way to model M:N.

**The cents-vs-Reais bug lives here.** `price_brl` is an integer storing cents (e.g. 131_965 means R$1,319.65). The column name reads as "BRL the currency" — and the agent treats it as such. File 10 walks the cost.

```
  order_items — the bridge, with the unit-name bug labeled

    order_id   TEXT NOT NULL REFERENCES orders(id)
    product_id TEXT NOT NULL REFERENCES products(id)
    price_brl  INTEGER NOT NULL    ← cents, NOT Reais (file 10)
    freight_brl INTEGER NOT NULL   ← cents, NOT Reais (file 10)

  idx_items_order   covers order_id   → orders join
  idx_items_product covers product_id → products join

  fix: rename to price_brl_cents OR return Reais in the tool output.
```

#### `payments` — the value-bearing side relation

4 columns. `order_id FK NOT NULL`, `type TEXT NOT NULL`, `installments INTEGER NOT NULL`, `value_brl INTEGER NOT NULL`. **Multiple rows per order** — a split payment shows up as two rows. The `type` is one of `credit_card`, `boleto`, `voucher`, `debit_card`; weights match the real Olist distribution (60% credit_card, 25% boleto, 10% voucher, 5% debit_card).

**Why the voucher dropoff seeded anomaly works:** the seeder applies multiplier 0.05 to `voucher` payments from week 10 onward. The `idx_payments_type` index makes "where type='voucher'" cheap; the detection query (`get_metric_timeseries(metric='payment_value', dimension='payment_type')`) returns a per-type aggregation; the agent compares the recent window to the baseline. The schema makes this possible in two indexed reads.

#### `reviews` — the unused-for-now side relation

3 columns. `order_id FK NOT NULL`, `score INTEGER NOT NULL`, `ts INTEGER NOT NULL`. No current tool queries reviews. The table exists because real Olist data has reviews and a future "review score by segment" tool would need them. The index `idx_reviews_order` is pre-built for that future tool.

**This is the most speculative table** — present for fidelity, not yet used. The cost is one table + one index per seed. Negligible. The benefit is the schema doesn't have a `reviews` shaped hole when a future tool needs to add one.

#### `seeded_anomalies` — ground truth as data

7 columns. `id` PK, `metric`, `dimension`, `segment`, `start_ts INTEGER NOT NULL`, `end_ts INTEGER NOT NULL`, `expected_severity TEXT NOT NULL`, `description TEXT NOT NULL`. This table is **not joined anywhere** — it's read by `eval/scripts/run-detection.ts` to compute precision/recall against the monitoring agent's output. File 09 walks the eval contract.

**What's missing from this table:** the multiplier value (`_generator.value` in the seed source) — `0.7` for SP-revenue, `2.5` for electronics, `0.05` for voucher. The multiplier is the load-bearing fact about each anomaly; it lives only in the seed constant, not in the row. That's the audit's finding #4 — description-vs-multiplier drift risk.

### Move 3 — the principle

A relational schema is correct when every column is justified by a query and every constraint is justified by an invariant the queries depend on. The Olist schema runs this discipline end-to-end: every column has a named consumer (with `weight_g` and the reviews table as the two intentional exceptions for dataset fidelity), every FK matches a real join, every NOT NULL matches a real "this can't be missing" invariant, every index matches a predicate the tools issue. The textbook lesson "design the schema against the queries" plays out concretely here. The places it cracks are the new audit findings: the unit-in-name bug (column says Reais, stores cents) and the description-vs-multiplier drift in `seeded_anomalies`.

### Code in this codebase

The repo anchors for the schema constant and the load-bearing runtime pragmas.

#### The schema string

```
mcp-server-olist/scripts/seed-olist.ts  (lines 184–245)

  const SCHEMA_SQL = `
  CREATE TABLE customers (
    id    TEXT PRIMARY KEY,                       ← string PK; uuid-shaped
    state TEXT NOT NULL,                          ← 'SP', 'RJ', ...
    city  TEXT NOT NULL
  );

  CREATE TABLE products (
    id        TEXT PRIMARY KEY,
    category  TEXT NOT NULL,                       ← closed enum (7 values)
    weight_g  INTEGER NOT NULL
  );

  CREATE TABLE orders (
    id           TEXT PRIMARY KEY,
    customer_id  TEXT NOT NULL REFERENCES customers(id),  ← FK + NOT NULL
    status       TEXT NOT NULL,
    purchase_ts  INTEGER NOT NULL,                         ← epoch seconds
    delivered_ts INTEGER                                    ← nullable
  );

  CREATE TABLE order_items (
    order_id    TEXT NOT NULL REFERENCES orders(id),
    product_id  TEXT NOT NULL REFERENCES products(id),
    price_brl   INTEGER NOT NULL,                          ← ★ cents (file 10)
    freight_brl INTEGER NOT NULL                            ← ★ cents (file 10)
  );

  CREATE TABLE payments (
    order_id     TEXT NOT NULL REFERENCES orders(id),
    type         TEXT NOT NULL,                            ← 4-value enum
    installments INTEGER NOT NULL,
    value_brl    INTEGER NOT NULL                          ← ★ cents (file 10)
  );

  CREATE TABLE reviews (
    order_id TEXT NOT NULL REFERENCES orders(id),
    score    INTEGER NOT NULL,
    ts       INTEGER NOT NULL
  );

  CREATE TABLE seeded_anomalies (
    id                TEXT PRIMARY KEY,
    metric            TEXT NOT NULL,
    dimension         TEXT NOT NULL,
    segment           TEXT NOT NULL,
    start_ts          INTEGER NOT NULL,
    end_ts            INTEGER NOT NULL,
    expected_severity TEXT NOT NULL,
    description       TEXT NOT NULL
    ← multiplier NOT stored (audit finding #4)
  );

  CREATE INDEX idx_orders_purchase_ts ON orders(purchase_ts);
  CREATE INDEX idx_orders_customer    ON orders(customer_id);
  CREATE INDEX idx_items_order        ON order_items(order_id);
  CREATE INDEX idx_items_product      ON order_items(product_id);
  CREATE INDEX idx_payments_order     ON payments(order_id);
  CREATE INDEX idx_reviews_order      ON reviews(order_id);
  CREATE INDEX idx_customers_state    ON customers(state);
  CREATE INDEX idx_products_category  ON products(category);
  CREATE INDEX idx_payments_type      ON payments(type);
  `;
       │
       └─ one constant. one source of truth. every CREATE INDEX has a
          named tool consumer (file 03 walks them).
```

#### The runtime pragmas

```
mcp-server-olist/src/db.ts  (lines 32–43)

  export function openDb(path: string = resolveDbPath()): Database.Database {
    if (!existsSync(path)) {
      throw new Error(`olist.db not found at ${path} — run 'npm run seed' ...`);
    }
    const db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma('journal_mode = WAL');     ← concurrent readers
    db.pragma('foreign_keys = ON');      ← FK enforcement
    return db;
  }
       │
       └─ both pragmas are LOAD-BEARING:
          - SQLite default is foreign_keys=OFF; without this pragma the
            FK DDL is documentation, not enforcement.
          - WAL mode allows multiple readers without blocking. crash-
            consistent durability via the WAL log.
```

---

## Primary diagram

The full Olist schema, recap.

```
  Olist schema — full recap (mcp-server-olist/scripts/seed-olist.ts)

  customers (id, state, city)                  5,000 rows
   │ FK customer_id
   ▼
  orders (id, customer_id, status,             ~9,800 rows
          purchase_ts, delivered_ts)            6-month horizon
   │           │           │                    (2025-12-01 → 2026-06-01)
   │ FK        │ FK        │ FK
   ▼           ▼           ▼
  order_items  payments    reviews              ~13k items
  (price_brl   (type,      (score,              ~10k payments
   = CENTS!)    value_brl   ts)                 ~6.8k reviews
   │            = CENTS!)                       (70% of orders)
   │ FK product_id
   ▼
  products (id, category, weight_g)            varies; weight unused

  ─────────────────────────────────────────────────────────────
  Not joined; read by evals:

  seeded_anomalies (id, metric, dimension,     3 rows: SP-revenue,
                    segment, start_ts, end_ts,  electronics-spike,
                    expected_severity, desc)    voucher-dropoff

  ─────────────────────────────────────────────────────────────
  PRAGMA foreign_keys = ON      ← FK enforcement
  PRAGMA journal_mode = WAL     ← concurrent reads
  Read-only at runtime; rebuilt by `npm run seed` (deterministic).
```

---

## Elaborate

The deepest structural point about this schema is that **the synthetic-data origin doesn't relax the design discipline**. A common temptation when seeding fake data is to flatten everything into one big table — "we control the data, why bother normalizing?" The Olist schema doesn't take that shortcut: customers and products live in their own tables, the order-items bridge is an actual bridge, payments come off orders as a separate relation. The result is a schema that *behaves like a real Olist dataset under analytics workloads* — joins exist, the optimizer has indexes to pick, the agent's queries return realistic shapes. The fidelity matters because the evals (file 09) are checking the agent's competence on a Brazilian-e-commerce domain; a flattened schema would let the agent succeed via shortcuts that wouldn't survive contact with real Olist data.

The most interesting design call is the **`weight_g` column on products plus the entire `reviews` table** — both present but currently unused. The discipline elsewhere is "no speculative columns." These two are deliberate exceptions for dataset-shape fidelity: a real Olist dataset has both, and a future tool that needs them would expect them in the obvious places. The cost is two pre-built indexes that nothing reads today; the benefit is "the schema doesn't have a shaped hole when the tool that needs reviews lands." Pragmatic.

The `seeded_anomalies` table is the cleverest piece — it's the **eval contract embedded in the data itself**. Phase 3's `run-detection.ts` doesn't read a separate "expected anomalies" config file; it queries `SELECT * FROM seeded_anomalies` and matches the monitoring agent's output against the rows. The DB is the documentation; the description column IS the human-readable spec; the metric/dimension/segment columns ARE the matching keys. The only drift risk is that the multiplier value (the load-bearing fact) lives only in the seed constant — audit finding #4 names the fix.

## Interview defense

**Q: Walk me through the Olist schema.**
A: Seven tables in `mcp-server-olist/scripts/seed-olist.ts`'s `SCHEMA_SQL` constant. Five "real" relations: `customers` (id, state, city), `products` (id, category, weight_g), `orders` (id, customer_id FK, status, purchase_ts, delivered_ts), `order_items` (the order×product bridge with `price_brl` and `freight_brl` in cents), `payments` (order_id FK, type, installments, value_brl in cents), `reviews` (order_id FK, score, ts). Plus `seeded_anomalies` — not joined anywhere, it's read by the eval scripts to compute precision/recall. Nine indexes, each one matched to a tool query: `idx_orders_purchase_ts` for time-bucket aggregation, `idx_customers_state` and `idx_products_category` and `idx_payments_type` for the dimension filters, the per-table `idx_*_order` indexes for the joins. FKs enforced via `PRAGMA foreign_keys = ON`. WAL journal mode for concurrent reads.

**Q: What's wrong with the schema as designed?**
A: One real bug, one drift risk. The real bug is **`price_brl` (and `value_brl`, `freight_brl`) is stored as integer cents but the column name reads as "BRL the currency."** The agent's training data treats `_brl` as Reais, the prompt disclaimer is sometimes dropped, and the Phase 3 evals show the cost: AOV narrated as R$131,965 instead of R$1,319.65, recommendation judge's `impact_sized` collapses to 0. The fix is renaming to `price_brl_cents` or returning Reais in the tool output. The drift risk is `seeded_anomalies.description` — the multiplier value (`0.7` for SP-revenue, etc.) lives only in the seed script's `SEEDED_ANOMALIES` constant, not in the table. A future tweak to the multiplier without updating the description leaves the eval valid but the documentation stale.

```
  diagram while you talk

  customers ── orders ── order_items ── products
                  │           │
                  ├── payments  (with value_brl ★cents)
                  └── reviews

  seeded_anomalies (separate; eval contract)

  9 indexes, each matched to a tool query
  FK + WAL + NOT NULL — real integrity

  ★ price_brl stores cents but the name says BRL → file 10
```

## See also

- `01-the-data-model-and-its-shape.md` — the agent-contract layer that sits above this schema; the `WorkspaceSchema` interface that bridges Olist and Bloomreach.
- `03-indexing-vs-query-patterns.md` — each index walked against the tool query it supports.
- `04-transactions-and-integrity.md` — FK enforcement via the pragma; WAL durability; the seed transaction.
- `05-migrations-and-evolution.md` — drop-and-reseed as the legitimate "no migrations" strategy here.
- `09-deterministic-synthetic-data.md` — how the data lands in this schema (mulberry32 + the seeded anomalies).
- `10-units-in-column-names.md` — the `price_brl` bug walked end-to-end with the eval evidence.

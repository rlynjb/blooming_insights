# Study — Database Systems (blooming insights)

## the verdict, before anything else

**The main Next.js app still has no database.** Its own `package.json` lists no driver — no `pg`, `mysql2`, `redis`, `prisma`, `drizzle`, `mongoose`, `@upstash/*`. State lives in `Map`s in one Node process.

**BUT — Phase 2 added a sibling package, `mcp-server-olist/`, that DOES have a real database.** It's `better-sqlite3` against `mcp-server-olist/data/olist.db` (3.5 MB, committed to git), seeded deterministically with synthetic Brazilian e-commerce data (5k customers, ~10k orders, 6-month window). The main app reaches it through MCP tool calls — same shape as Bloomreach, except the data layer is **one process away, in our own repo, with a real SQL engine** behind it. That changes the verdict on half this guide.

So the storage map has two altitudes now:

```
  altitude 1: the main Next.js app           altitude 2: the sibling MCP server
  ─────────────────────────────              ─────────────────────────────
  no DB, all in-memory                       SQLite (better-sqlite3)
  Maps + cookies + JSON cache                7 tables, 9 indexes, WAL mode
  → most of this guide's "not yet            committed binary DB as fixture
     exercised" still holds                  → 02, 03, 04, 05, 07 now exercise
                                               REAL database mechanics
```

What the main app has instead, ranked by how close each gets to being database-shaped:

```
  closest to a DB ──────────────────────────────────────► furthest from a DB

  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
  │ MCP response cache    │  │ in-process state      │  │ encrypted cookie      │
  │ Map + TTL + minInterval│  │ Map (insights /       │  │ (bi_auth, AES-GCM)    │
  │ lib/mcp/client.ts L80  │  │  investigations /     │  │ lib/mcp/auth.ts L48   │
  │                       │  │  anomalies)           │  │                       │
  │ → an in-memory KV     │  │ lib/state/insights.ts │  │ → durable but         │
  │   with expiry         │  │ L4-L6                 │  │   request-scoped       │
  └──────────────────────┘  └──────────────────────┘  └──────────────────────┘

  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
  │ schema cache (module  │  │ dev file caches      │  │ Bloomreach upstream   │
  │  global)              │  │ .auth-cache.json     │  │ (the real DB —        │
  │ lib/mcp/schema.ts     │  │ .investigation-      │  │  someone else's)      │
  │  L131                 │  │  cache.json          │  │ behind MCP tools      │
  │                       │  │ lib/state/*.ts L7-L9 │  │                       │
  │ → process-singleton   │  │ → dev-only JSON      │  │ → not "ours"          │
  └──────────────────────┘  └──────────────────────┘  └──────────────────────┘
```

Bloomreach Engagement is the real upstream data warehouse — multi-tenant, customer events, EQL query engine, opaque to us. The Olist MCP server is the **authored** data warehouse — we wrote the schema, we wrote the seed, we wrote the queries. Both reach the agents through MCP tool calls. The agents don't write SQL or EQL directly; they call domain tools (`execute_analytics_eql` for Bloomreach, `get_metric_timeseries` / `get_segments` / `get_anomaly_context` for Olist) and stitch the results into insights.

**The database concepts that matter here fall into three buckets now:**

1. **Inside the main app** — caching, cross-instance state, rate-limit coordination. Still mostly `not yet exercised` at the engine level.
2. **Inside `mcp-server-olist/`** — real SQL, real indexes, real prepared statements, real transactions on the seed write path. Sections 02, 03, 04, 05, 07 now have concrete code to anchor to.
3. **At the seam between them** — schema introspection (`olistWorkspaceSchema()` in `lib/mcp/schema.ts` L232), the committed binary DB as test fixture, seeded determinism (mulberry32 seed=42). New file: `10-embedded-sqlite-fixture.md`.

## why this guide exists

Database-systems thinking pays in two places now:

1. **At the main-app altitude** — the MCP cache is a tiny KV with TTL; the in-process `Map`s in `lib/state/insights.ts` behave like a single-writer table without persistence or isolation; cross-instance divergence is real. These are still `not yet exercised` at the engine level, but the patterns are database-shaped.
2. **At the sibling-package altitude** — `mcp-server-olist/src/db.ts` opens SQLite read-only with `journal_mode = WAL`. The seed script (`mcp-server-olist/scripts/seed-olist.ts` L508-544) wraps the bulk insert in `db.transaction(() => ...)`. The three tool queries (`mcp-server-olist/src/tools/*.ts`) hit B-tree indexes on `(purchase_ts)`, `(customer_id)`, `(order_id)`, `(category)`, etc. — real query-planner territory.
3. The day a feature in the main app needs to survive a cold start — saved searches, per-user history, audit logs — you'll reach for Postgres. The teaching here primes you on which engine guarantees you'd be picking up, and the Olist package gives you SQL pattern shapes to point at.

So sections that touch the main app still read `not yet exercised` — and each names the trigger that flips the verdict. Sections that touch SQL mechanics (02-05, 07) now have real codebase anchors via `mcp-server-olist/`.

## the storage map (such as it is)

```
  blooming insights — every place a byte lives (Phase 2 expanded)

  ┌─ Browser ─────────────────────────────────────────────────────────────┐
  │  sessionStorage (insight handoff between feed → /investigate)         │
  │  bi_session cookie (uuid, httpOnly, 10-day)                           │
  │  bi_auth cookie (encrypted store of OAuth tokens, prod only)          │
  └───────────────────────────────────┬───────────────────────────────────┘
                                      │
  ┌─ Vercel Serverless Function (one warm Node process) ────────────────────┐
  │                                                                         │
  │  ┌─ lib/mcp/client.ts ────────────────┐  ┌─ lib/mcp/schema.ts ────────┐ │
  │  │ cache: Map<key, {result,expiresAt}>│  │ cached: WorkspaceSchema    │ │
  │  │ TTL default 60_000ms               │  │ (module global, no TTL)    │ │
  │  │ minIntervalMs=1100 (rate limit)    │  │ olistWorkspaceSchema()     │ │
  │  └────────────────────────────────────┘  │ derives from db.ts contract│ │
  │                                          └────────────────────────────┘ │
  │  ┌─ lib/state/insights.ts ────────────┐  ┌─ lib/state/investigations.ts┐│
  │  │ insights / investigations /         │  │ mem: Map<id, AgentEvent[]>  ││
  │  │ anomalies Maps (no persistence)    │  │ + .investigation-cache.json ││
  │  └────────────────────────────────────┘  │   (dev only)                ││
  │                                          └─────────────────────────────┘│
  │  ┌─ lib/mcp/auth.ts ──────────────────────────────────────────────────┐ │
  │  │ dev: .auth-cache.json    test: memStore Map    prod: bi_auth cookie│ │
  │  │ AES-256-GCM under AUTH_SECRET (prod)                               │ │
  │  └────────────────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────┬───────────────────────────────────┘
                                        │  MCP stdio subprocess (Olist mode)
                                        │  OR network (Bloomreach mode)
                  ┌─────────────────────┴─────────────────────┐
                  ▼                                            ▼
  ┌─ mcp-server-olist/ (sibling package, OUR DB) ──┐  ┌─ Bloomreach (upstream)┐
  │  better-sqlite3, read-only, journal_mode=WAL    │  │  EQL engine; we never │
  │  data/olist.db (3.5 MB, committed to git)       │  │  see schemas, plans,  │
  │                                                  │  │  or indexes           │
  │  Tables: customers, products, orders,            │  │                       │
  │          order_items, payments, reviews,         │  │  rate-limited globally│
  │          seeded_anomalies                        │  │  per user: ~1 req/s   │
  │                                                  │  └───────────────────────┘
  │  Indexes (9): orders.purchase_ts, orders.cust,   │
  │   items.order, items.product, payments.order,    │
  │   reviews.order, customers.state, products.cat,  │
  │   payments.type                                  │
  │                                                  │
  │  Tools (3): get_metric_timeseries,               │
  │             get_segments,                        │
  │             get_anomaly_context                  │
  │                                                  │
  │  Seed: mulberry32 PRNG, seed=42, 5k customers,   │
  │        ~10k orders, 6-month window               │
  │        (2025-12-01 .. 2026-06-01)                │
  │  3 anomalies injected as ground truth:           │
  │   - sp-revenue-drop-w4   (×0.7, week 4, SP)      │
  │   - electronics-spike-w2 (×2.5, week 2, electr.) │
  │   - voucher-dropoff-w10  (×0.05, weeks 10-end)   │
  └─────────────────────────────────────────────────┘
```

The main app has nothing the next deploy doesn't reset. The Olist package has a 3.5 MB committed binary that survives every deploy because it's in the git tree — that's a deliberate trade (large repo) for reproducibility (every clone gets the same fixture, byte for byte).

## what to read first (and why)

```
  reading order — verdict-first

  01  database-systems-map           ← what's where across BOTH altitudes.
                                       main app: in-memory. Olist: SQLite.

  02  records-pages-and-storage-layout    EXERCISED in mcp-server-olist
                                          (SQLite pages, WAL mode, 9 indexes).
                                          main app still has no pages.
  03  btree-hash-and-secondary-indexes    EXERCISED in mcp-server-olist
                                          (9 named B-tree indexes; see Move 2).
  04  query-planning-and-execution         EXERCISED in mcp-server-olist
                                          (SQLite planner runs the JOINs in
                                          get_metric_timeseries; EXPLAIN works).
  05  transactions-isolation-and-anomalies PARTIALLY EXERCISED
                                          (seed-olist.ts wraps the bulk insert
                                          in db.transaction(); main app has none)
  06  locks-mvcc-and-concurrency-control   not yet exercised — main app's Maps;
                                          SQLite is read-only single-process for us
  07  wal-durability-and-recovery          EXERCISED in mcp-server-olist
                                          (PRAGMA journal_mode = WAL on open;
                                          read-only so no checkpointer pressure)
  08  replication-and-read-consistency     not yet exercised — single source upstream,
                                          per-instance caches CAN diverge (named, see 08)
  09  database-systems-red-flags-audit    ranked risks across BOTH altitudes
  10  embedded-sqlite-fixture             NEW — better-sqlite3 trade-offs, seeded
                                          determinism, committed binary as fixture,
                                          schema introspection (db→schema contract)
```

Read **01**, **10**, and **09** if you only have fifteen minutes — together they cover the honest picture across both altitudes.

## the actually-applicable sections (post-Phase 2)

The list of "what's exercised" got longer:

- **01 — database-systems-map.** The full layout above is real, now across two altitudes.
- **02 — records, pages, storage layout.** `mcp-server-olist/data/olist.db` is a real B-tree-on-disk file with 8KB pages by SQLite default.
- **03 — B-tree and secondary indexes.** Nine named indexes in `mcp-server-olist/scripts/seed-olist.ts` L236-244. Every tool query relies on at least one.
- **04 — query planning.** The `get_metric_timeseries` tool issues real JOINs that SQLite's cost-based planner handles. `EXPLAIN QUERY PLAN` returns real output against this DB.
- **05 — transactions.** The seed script's `db.transaction(() => { ... })` wrapper is a real ACID transaction (SQLite's default is serializable). One transaction inserts ~30k rows atomically.
- **06 — concurrency.** Main app still has the same gaps. SQLite is opened `readonly: true` so no write contention; WAL would give MVCC if we wrote, but we don't.
- **07 — WAL.** `mcp-server-olist/src/db.ts` L40 sets `PRAGMA journal_mode = WAL`. The `.db-wal` and `.db-shm` files in `data/` are real WAL artifacts.
- **08 — replication.** Still no replicas. The cross-instance divergence story in the main app is unchanged.
- **10 — embedded SQLite fixture.** The whole pattern of "data layer one process away" — what better-sqlite3 buys you that an async driver doesn't, why the binary DB is committed, how seed determinism makes the eval suite hermetic.

## when a real DB would change the calculus

Any of these features flips the verdict from `not yet exercised` to load-bearing:

```
  feature you might add              database concept it forces you to learn

  per-user saved insights      →     primary keys, foreign keys, B-tree indexes
                                     on (user_id, timestamp)
  insight history (not just     →     append-only writes, time-range scans, partitions
   the latest briefing)
  share an investigation        →     read-after-write consistency across requests
   via a URL
  team workspaces               →     row-level authorization, multi-tenancy
  long-running async briefings  →     a job queue with at-least-once delivery
   (>300s)                            and idempotency keys
  rate-limit budget shared      →     atomic counter with TTL (Redis INCR + EXPIRE)
   across all instances
  cache that survives a deploy  →     external KV (Upstash / Redis / Vercel KV)
  audit log of who saw what     →     append-only log table, WAL semantics matter
  comparing this week to        →     time-partitioned tables OR a columnar store
   last quarter at scale              (BigQuery / ClickHouse)
```

None of these are speculation about a far future. They're the natural next steps if blooming insights graduates from "live demo of one workspace" to "tool a team logs into." The teaching in each section names which one would trigger it.

## anchoring rules followed

- Every applied claim ties to a `file:line` range.
- Every `not yet exercised` verdict names the closest cousin in this codebase and the trigger that would flip it.
- Two altitudes named explicitly: main app (no DB), sibling MCP server (SQLite).
- No invented infrastructure for the main app. SQLite claims tie to `mcp-server-olist/src/db.ts` and `mcp-server-olist/scripts/seed-olist.ts`.
- Cross-links go to `study-system-design` (which engine you'd pick) and `study-data-modeling` (the shape of what you'd store), not re-taught here.

## see also

- `study-data-modeling` — the SHAPE of data, including the Olist schema
- `study-system-design` — WHICH datastore, when you reach for one
- `study-runtime-systems` — Node process model; better-sqlite3 sync vs async drivers
- `study-distributed-systems` — why per-instance caches diverge under load
- `study-testing` — the eval suite uses the SQLite-backed fixture for hermetic agent tests

---
Updated: 2026-06-16 — Phase 2 added a sibling SQLite-backed MCP server; verdict no longer "zero DB"; new file 10-embedded-sqlite-fixture.md; sections 02/03/04/05/07 now exercise real SQL mechanics.

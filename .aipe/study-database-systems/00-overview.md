# Database Systems — overview

*Case B teaching (no DB): the primitives that fill the DB's roles in a repo that has no engine.*

**The verdict.** This repo has no database. It has three memory primitives, one committed JSON tree, and one encrypted cookie doing the storage-engine's job across three or four different responsibilities. Every study-database-systems concept below teaches the standard mechanism first, then names which of those primitives plays its role here — and which roles are `not yet exercised` at all.

The system, drawn once:

```
  the whole storage picture — every "database" in this repo

  ┌─ Bloomreach Engagement (managed) ────────────────────────────┐
  │  the real database. EQL over MCP. We don't operate it.       │ ← study-system-design owns this
  └───────────────────┬──────────────────────────────────────────┘
                      │ execute_analytics_eql (MCP)
                      ▼
  ┌─ Vercel serverless (Next 16 App Router) ─────────────────────┐
  │                                                              │
  │  session Map<sessionId, SessionFeed>       lib/state/insights.ts:14
  │    → the "current" briefing per user      (in-memory, warm-start-wiped)
  │                                                              │
  │  TTL response cache (60s per call)         lib/data-source/…:122
  │    → same tool+args returns instantly     (per warm instance)
  │                                                              │
  │  bi_auth AES-256-GCM cookie                lib/mcp/auth.ts:38-104
  │    → OAuth tokens, PKCE verifier          (the ONLY prod durability)
  │                                                              │
  └───────────────────┬──────────────────────────────────────────┘
                      │ read at request time
                      ▼
  ┌─ committed JSON in git ──────────────────────────────────────┐
  │  lib/state/demo-*.json          — the "read replica"          │
  │  eval/baseline.json             — the committed reference row │
  │  eval/receipts/*.json           — 28 rows, per (case × runId) │
  │  eval/goldens/*.ts              — fixture "seed data"         │
  └──────────────────────────────────────────────────────────────┘
```

## Ranked findings — read these first

1. **The session Map is the entire OLTP surface.** `lib/state/insights.ts:14` — a `Map<sessionId, SessionFeed>` where each `SessionFeed` is three inner maps (insights, investigations, anomalies). `putInsights` runs `clear()` then re-populates (`insights.ts:57-71`). Warm-start wipes it. Nobody outside the process sees it. This is the "table," and it costs you nothing to lose because no user depends on it surviving a redeploy. Concept file: `05-transactions-isolation-and-anomalies.md`.

2. **The 60s response cache is the only index.** `lib/data-source/bloomreach-data-source.ts:122` — `Map<string, {result, expiresAt}>` keyed by `${name}:${JSON.stringify(args)}`. That's a hash-table lookup on the exact tool call. There is no B-tree, no covering index, no range scan structure anywhere. Concept file: `03-btree-hash-and-secondary-indexes.md`.

3. **`eval/baseline.json` is a committed row in git.** `eval/baseline.json:1-92` — one JSON object holding `perDimensionPassRate` and `verdictDistribution` for the frozen runId `2026-07-03T04-08-28-644Z`. `eval/gate.eval.ts:49-91` reads it as the reference "SELECT * FROM baseline WHERE runId = latest," compares against a candidate `computeBaseline(...)`, and fails the run when any dimension drops more than `GATE_MAX_REGRESSION` (0.10). Filesystem-as-committed-database is a Case B "table" — no engine, but the row is real. Concept files: `01-database-systems-map.md`, `08-replication-and-read-consistency.md`.

4. **The bi_auth cookie is the whole durability story.** `lib/mcp/auth.ts:38-104` — an AES-256-GCM encrypted httpOnly cookie holds OAuth client info, tokens, and the PKCE verifier. `AsyncLocalStorage` seeds a store from the cookie once at request start and flushes it once at the end (`auth.ts:86-104`), so the OAuth SDK's many synchronous reads/writes never race Next's request-vs-response cookie split. Warm-start wipes memory; the cookie survives on the client. Concept file: `07-wal-durability-and-recovery.md`.

5. **`public/demo/` and `lib/state/demo-*.json` are frozen read replicas.** `lib/state/demo-insights.json` (665 lines) + `lib/state/demo-investigations.json` (3487 lines) are pre-captured briefing + investigation streams. `app/api/briefing/route.ts:78-149` reads them and replays as NDJSON when `?demo=cached`. Same replica pattern as a Postgres follower — deliberately stale, faster to serve, doesn't hit the real backend. Concept file: `08-replication-and-read-consistency.md`.

6. **Node's single-threaded loop is the concurrency control.** No locks, no MVCC, no CAS. `putInsights` (`insights.ts:57-71`) is safe against intra-instance concurrent callers only because it never `await`s between `clear()` and the final `.set()` — the JS event loop treats the whole synchronous block as an atomic turn. Between different requests on the same warm Vercel instance, the AsyncLocalStorage-scoped auth store (`auth.ts:47, 86-104`) is what prevents cross-request bleed. Concept file: `06-locks-mvcc-and-concurrency-control.md`.

## `not yet exercised` — engine mechanics with no anchor in the repo

- **On-disk pages, extents, TOAST-style overflow storage** — everything lives in RAM or as whole JSON files. `02-records-pages-and-storage-layout.md`.
- **B-tree, LSM tree, columnar indexes** — no ordered index of any kind. `03-btree-hash-and-secondary-indexes.md`.
- **Query planner, EXPLAIN, join algorithms** — the agents choose queries, Bloomreach executes; we see no local plan. `04-query-planning-and-execution.md`.
- **Multi-statement transactions, BEGIN/COMMIT, savepoints, 2PC** — no atomic unit larger than one synchronous JS turn. `05-transactions-isolation-and-anomalies.md`.
- **Row locks, MVCC snapshots, SELECT FOR UPDATE, deadlock detection** — none of these exist because there is no concurrent writer. `06-locks-mvcc-and-concurrency-control.md`.
- **Write-ahead log, fsync barriers, checkpoints, PITR** — no engine, no WAL. Git tags (`study-pre-regen-2026-07-03`) are the human-scale rollback story. `07-wal-durability-and-recovery.md`.
- **Leader/follower replication, quorum reads, causal consistency, replication lag metrics** — the demo snapshot is a manually-refreshed replica; nothing streams changes. `08-replication-and-read-consistency.md`.

## Reading order

Read in file-number order. Each concept file walks the standard mechanism first, then names which primitive (or which absence) plays its role here.

1. `01-database-systems-map.md` — the whole storage picture, engines and non-engines named.
2. `02-records-pages-and-storage-layout.md` — records / pages / locality.
3. `03-btree-hash-and-secondary-indexes.md` — indexes and lookup structures.
4. `04-query-planning-and-execution.md` — planning, scans, joins, N+1.
5. `05-transactions-isolation-and-anomalies.md` — atomicity, isolation, anomalies.
6. `06-locks-mvcc-and-concurrency-control.md` — concurrency mechanics.
7. `07-wal-durability-and-recovery.md` — durability, backups, recovery.
8. `08-replication-and-read-consistency.md` — replicas, staleness, failover.
9. `09-database-systems-red-flags-audit.md` — ranked risks with evidence.

## Cross-links to adjacent generators

- **`study-data-modeling`** owns the *shape* of `Insight` / `Anomaly` / `Diagnosis` / `Recommendation` and whether the shape matches access patterns. This file owns the *mechanism* used to store and read those rows.
- **`study-system-design`** owns *which datastore was selected* and how it scales. This file owns what happens *inside* that choice — including the choice to have no local engine.
- **`study-distributed-systems`** owns coordination across processes/services. The AsyncLocalStorage isolation in `auth.ts:47, 86-104` gets treated there as request-scoping; here it shows up as concurrency control.
- **`study-runtime-systems`** owns the event loop and process model. The reason `putInsights` is atomic without a lock (`insights.ts:57-71`) lives there; here we consume it as an isolation guarantee.

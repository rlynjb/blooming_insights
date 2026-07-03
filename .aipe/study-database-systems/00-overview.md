# study — database systems (this repo)

> The MECHANISMS used to execute and preserve reads and writes. This is the
> partner to `study-data-modeling` (SHAPE of persistent data) and
> `study-system-design` (WHICH datastore, and how it scales).

## The verdict, before we start

There is **no database in this repo.** Not "we run Postgres in prod but the
tests hit SQLite" — there is no relational engine, no document store, no
`schema.sql`, no ORM, no migrations. `package.json` has zero DB clients.

That's not a bug in the study. It's the shape you're studying.

Every classical database-systems concept is here — a table exists, an index
exists, durability exists, a "reference row" exists, a backup exists — but
each one is **case B**: implemented as an in-memory Map, a TTL cache, a
committed JSON snapshot, an encrypted cookie, a git tag. You get to see
what a datastore is *actually doing* by watching this repo do the same jobs
without one.

## The full persistence hierarchy, at a glance

Six tiers of durability, ordered by how long they live and where they live.
Every mechanism in this study anchors to one of these tiers.

```
Persistence hierarchy in blooming_insights (no DB)

┌─ Tier 1 · localStorage (client, per-browser) ────────────────────────┐
│  bi:mcp_config           — the user's MCP server override            │
│  bi:mode                 — 'demo' | 'live-mcp' | 'live-synthetic'   │
│  survives tab close, browser restart, and app deploys                │
└──────────────────────────────────────────────────────────────────────┘
┌─ Tier 2 · sessionStorage (client, per-tab) ──────────────────────────┐
│  bi:insight:<id>         — insight cache for the investigate page   │
│  bi:diag:<id>            — diagnosis handoff step 2 → step 3        │
│  bi:inv:<step>:<id>      — trace stash for re-visits / back-nav     │
│  dies on tab close                                                   │
└──────────────────────────────────────────────────────────────────────┘
┌─ Tier 3 · In-memory Map (server, per-warm-instance) ─────────────────┐
│  Map<sessionId, SessionFeed>  in lib/state/insights.ts:14           │
│  dies on cold start / redeploy                                       │
└──────────────────────────────────────────────────────────────────────┘
┌─ Tier 4 · Server-signed cookies (per-user, cross-instance) ──────────┐
│  bi_auth      — AES-256-GCM encrypted OAuth state (10 days)         │
│  bi_session   — sessionId UUID (HttpOnly, SameSite=None on prod)    │
└──────────────────────────────────────────────────────────────────────┘
┌─ Tier 5 · File system (dev only) ────────────────────────────────────┐
│  .auth-cache.json  — gitignored plaintext OAuth store               │
│  survives Next hot-reload but not `rm`                               │
└──────────────────────────────────────────────────────────────────────┘
┌─ Tier 6 · Git-committed (durable, versioned) ────────────────────────┐
│  eval/baseline.json                — reference row for the CI gate  │
│  eval/receipts/*.json              — the "table" of judged runs     │
│  lib/state/demo-insights.json      — frozen read replica            │
│  lib/state/demo-investigations.json                                  │
└──────────────────────────────────────────────────────────────────────┘
```

The interesting thing about this hierarchy: **git is the most durable layer,
and it is neither a database nor invisible to users.** The commit hash is
the LSN. `git tag study-pre-regen-2026-07-03-p2` is today's backup
(pre-regen safety tag). `git revert` is your rollback.

## The Case B analogy table

Every classical DB concept has a real analog somewhere in this codebase.
The concept files walk each one with real `file:line` grounding.

| DB primitive              | Repo analog                                                   | File                                              |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| **table**                 | `Map<sessionId, SessionFeed>`                                 | `lib/state/insights.ts:14`                        |
| **primary key**           | `sessionId` (bi_session cookie UUID) → outer map key          | `lib/mcp/session.ts:3`                            |
| **secondary key**         | `insight.id` (crypto.randomUUID) → inner map key              | `lib/state/insights.ts:26`                        |
| **index / hot cache**     | 60 s TTL response cache per `${name}:${JSON.stringify(args)}` | `lib/data-source/bloomreach-data-source.ts:122`   |
| **read replica**          | committed JSON snapshot                                       | `lib/state/demo-insights.json`                    |
| **committed ref row**     | `eval/baseline.json` (frozen per-dim pass rates)              | `eval/baseline.json`                              |
| **write-once durable row**| bi_auth cookie (AES-256-GCM encrypted OAuth store)            | `lib/mcp/auth.ts:34-104`                          |
| **backup / point-in-time**| `git tag study-pre-regen-2026-07-03-p2`                       | git                                               |
| **rollback**              | `git revert` / `git reset --hard <tag>`                       | git                                               |
| **client-side KV store**  | `localStorage['bi:mcp_config']`                               | `lib/mcp/config.ts:34, 107, 121`                  |
| **client-side cache**     | `sessionStorage['bi:insight:<id>']`                           | `lib/hooks/useBriefingStream.ts:57`               |
| **WAL / redo log**        | `eval/receipts/*.json` — every judged run, append-only       | `eval/receipts/`                                  |
| **replica lag**           | time since last `capture-demo` capture                        | `app/api/mcp/capture-demo/route.ts:34`            |
| **serializable txn**      | not yet exercised                                             | —                                                 |
| **MVCC / snapshot iso**   | not yet exercised (React's snapshot model is the nearest kin) | —                                                 |
| **B-tree index**          | not yet exercised                                             | —                                                 |

## What this study is going to cover, in order

Each file uses the full concept-file template (Zoom out → Structure pass →
How it works → Diagram → Elaborate → Interview defense → See also). No
Pass 1 / Pass 2 shape — this is a curriculum topic, not an audit.

  1. **`01-database-systems-map`** — the whole persistence hierarchy in one
     diagram. Where OLTP would sit if it existed; where every tier lives now.

  2. **`02-records-pages-and-storage-layout`** — records, pages, locality,
     and the cost model. Anchored to the `SessionFeed` record shape, the
     receipt files, and the localStorage layout.

  3. **`03-btree-hash-and-secondary-indexes`** — index structures, lookup
     behavior, write costs, and index selection. Case B: the JS `Map`
     hash-index, the 60 s response cache key.

  4. **`04-query-planning-and-execution`** — plans, scans, joins, N+1. The
     agent loop as the query planner; MCP tool calls as scans; per-request
     cache as the buffer pool.

  5. **`05-transactions-isolation-and-anomalies`** — atomicity, isolation,
     the anomalies you get for free by never coordinating writes.
     Anchored to `putInsights`'s `.clear()` race and the cookie
     request-vs-response split.

  6. **`06-locks-mvcc-and-concurrency-control`** — locks, MVCC, optimistic
     vs pessimistic. Case B: the AsyncLocalStorage-scoped auth store as
     "per-request MVCC," the module-level Map as "no locking, no isolation."

  7. **`07-wal-durability-and-recovery`** — WAL, durability boundaries,
     backup, restore. The receipts folder as the append-only log; the git
     tag as the point-in-time snapshot; the baseline.json as the committed
     reference row.

  8. **`08-replication-and-read-consistency`** — replicas, lag, failover,
     stale reads. Case B: `demo-insights.json` as the frozen replica;
     capture-demo as the replication moment; `?demo=cached` as the
     stale-read fallback.

  9. **`09-database-systems-red-flags-audit`** — ranked storage-engine and
     consistency risks in this codebase, top-down.

## Ranked findings (the executive summary)

Top three risks, ordered by consequence. Every one is anchored to a real
file:line and explained in `09-database-systems-red-flags-audit.md`.

  1. **The auth cookie IS your database.** `bi_auth` is the only production
     durability layer for OAuth state. AES-256-GCM protects it; nothing
     backs it up. Rotate `AUTH_SECRET` and every logged-in user is signed
     out — `decryptStore()` at `lib/mcp/auth.ts:69` returns `{}` on a bad
     tag and the app treats that as "no auth." (`lib/mcp/auth.ts:34-104`)

  2. **`putInsights` has a between-request race.** The outer
     `Map<sessionId, SessionFeed>` is not cleared, but the inner sub-map
     is unconditionally `.clear()`-ed on every briefing. A user who kicks
     off a second briefing while the first is still writing wipes the
     first. No isolation, no versioning. (`lib/state/insights.ts:64-71`)

  3. **The frozen replica has no lag metric.** `demo-insights.json` is
     hand-refreshed via `/api/mcp/capture-demo` and committed to git.
     There is no timestamp check; the demo mode will happily replay a
     6-month-old snapshot with no warning. In DB terms: a read replica
     with no lag alert. (`app/api/mcp/capture-demo/route.ts:34-58`)

## What is `not yet exercised` in this repo

Called out honestly so the concept files don't manufacture findings:

  → **B-tree indexes** — no ordered index anywhere. `Map` is hash-only.
  → **Multi-row transactions** — every write is a single map `.set()`.
  → **MVCC / snapshot isolation** — no versioning; the AsyncLocalStorage
    pattern in `withAuthCookies` is the nearest kin but is per-request,
    not per-row.
  → **Query planning / EXPLAIN** — the agent loop plans "which tool to
    call next," but no cost-based optimizer sits between plan and
    execution.
  → **Two-phase commit / distributed txn** — Vercel warm instances share
    nothing; consistency is "the browser carries the state."
  → **WAL / redo log with recovery** — receipts are append-only but
    never replayed; they're an audit log, not a recovery log.
  → **Failover / high availability** — one Vercel deployment; no replica
    promotion; no read/write split.

Each of these gets one paragraph in the relevant concept file with a
`not yet exercised` label — and a note on **when it becomes relevant.**

## Reading order

Read `01-database-systems-map` first. That one puts every mechanism on the
map. From there:

  → If you want to reason about the storage engine — 02, 03, 04 in order.
  → If you want to reason about concurrency and durability — 05, 06, 07.
  → If you want the replica story — 08.
  → For the ranked risk audit — 09.

The concept files stand alone; you can open any one and understand it. The
map file is what makes them all point at the same picture.

## See also

  → `study-data-modeling/` — the SHAPE of the same data (record layout,
    relationships, integrity)
  → `study-system-design/` — WHICH datastore was chosen and why (or,
    here, why none was)
  → `study-distributed-systems/` — coordination across replicas and warm
    instances; the neighboring "many boxes, partial failure" concerns
  → `study-runtime-systems/` — the process/instance model that makes the
    Map-as-table story break under cold starts

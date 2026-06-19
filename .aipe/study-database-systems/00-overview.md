# Study — Database Systems (blooming insights)

## the verdict, before anything else

**This app has no database.** `package.json` lists no driver — no `pg`, `mysql2`, `redis`, `prisma`, `drizzle`, `mongoose`, `@upstash/*`, no `better-sqlite3`. State lives in `Map`s in one Node process. Auth lives in an encrypted cookie. Demo data lives in committed JSON. The Bloomreach upstream is where the real data is, and it's opaque to us via MCP tools. The synthetic data source (`lib/data-source/synthetic-data-source.ts`) is in-process, deterministic, and uses no persistent storage at all — it returns static const schema + synthesized tool responses per call.

So most of this guide is going to read `not yet exercised`. That's the honest framing. **What IS exercised is everything around storage — caching, rate-limit coordination, request-scoped state, cookie crypto — and those are where the database-systems concepts touch real code.**

The thing closest to a database here, ranked by how close each gets:

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

  ┌──────────────────────┐
  │ synthetic data source │
  │ in-process static     │
  │ schema + synthesized  │
  │ tool responses        │
  │ lib/data-source/      │
  │  synthetic-data-      │
  │  source.ts            │
  │ → deterministic, no   │
  │   persistence at all  │
  └──────────────────────┘
```

Bloomreach Engagement is the real data warehouse — multi-tenant, customer events, EQL query engine, opaque to us. The agents don't write SQL or EQL directly; they call domain tools (`execute_analytics_eql`, etc.) and stitch the results into insights. The synthetic data source is the demo backstop: same tool surface, no network, deterministic responses constructed in-memory from a static const `syntheticWorkspaceSchema`.

**The database concepts that matter here:** caching (the only place we hand-rolled a tiny KV), cross-instance state (the gap that bites at scale), and the lifetime hierarchy that determines what survives a cold start. That's the lens; everything else is `not yet exercised` with a named trigger.

## why this guide exists

Database-systems thinking pays here in three places, even without a database:

1. **The MCP cache is a tiny KV with TTL.** Read it as your introduction to "what an in-memory KV actually is."
2. **The in-process `Map`s in `lib/state/insights.ts`** behave like a single-writer table without persistence or isolation. The gap that opens at two instances is the multi-writer story.
3. **The day a feature needs to survive a cold start** — saved searches, per-user history, audit logs — you'll reach for Postgres. The teaching here primes you on which engine guarantees you'd be picking up.

So most sections read `not yet exercised` — and each one names the trigger that flips the verdict. That's the honest framing: zero database today, here's the closest cousin, here's the line you'd cross to need the real thing.

## the storage map (such as it is)

```
  blooming insights — every place a byte lives

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
  │  │ minIntervalMs=1100 (rate limit)    │  │                            │ │
  │  └────────────────────────────────────┘  └────────────────────────────┘ │
  │                                                                         │
  │  ┌─ lib/state/insights.ts ────────────┐  ┌─ lib/state/investigations.ts┐│
  │  │ insights / investigations /         │  │ mem: Map<id, AgentEvent[]>  ││
  │  │ anomalies Maps (no persistence)    │  │ + .investigation-cache.json ││
  │  └────────────────────────────────────┘  │   (dev only)                ││
  │                                          └─────────────────────────────┘│
  │  ┌─ lib/mcp/auth.ts ──────────────────────────────────────────────────┐ │
  │  │ dev: .auth-cache.json    test: memStore Map    prod: bi_auth cookie│ │
  │  │ AES-256-GCM under AUTH_SECRET (prod)                               │ │
  │  └────────────────────────────────────────────────────────────────────┘ │
  │                                                                         │
  │  ┌─ lib/data-source/synthetic-data-source.ts ────────────────────────┐ │
  │  │ static const syntheticWorkspaceSchema (in-process)                 │ │
  │  │ per-call synthesized tool responses (no persistent storage)        │ │
  │  └────────────────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────┬───────────────────────────────────┘
                                        │  network (HTTP MCP, live mode only)
                                        ▼
                            ┌─ Bloomreach (upstream) ┐
                            │  EQL engine; we never  │
                            │  see schemas, plans,   │
                            │  or indexes            │
                            │                        │
                            │  rate-limited globally │
                            │  per user: ~1 req/s    │
                            └────────────────────────┘
```

Nothing in this layout survives a deploy except the cookie and the committed files. Maps are recreated, `lastCallAt` is recreated, the schema cache is recreated. That's the entire architectural fact.

## what to read first (and why)

```
  reading order — verdict-first

  01  database-systems-map           ← what's where. tl;dr: not much.
                                       the only real "datastore" is the
                                       MCP cache.
  02  records-pages-and-storage-layout    not yet exercised — nothing to
                                          layout in JS Map / cookie / JSON
  03  btree-hash-and-secondary-indexes    not yet exercised — Map.get is the
                                          only "lookup," V8 hash table only
  04  query-planning-and-execution         not yet exercised — agents are the
                                          "planner"; Bloomreach is the executor.
                                          we see neither half's internals.
  05  transactions-isolation-and-anomalies not yet exercised — single-row
                                          mutations; no BEGIN/COMMIT in the repo
  06  locks-mvcc-and-concurrency-control   one real gap (Move 2c, rate-limit
                                          coordination across instances)
  07  wal-durability-and-recovery          not yet exercised — every write
                                          either ephemeral or browser-side
  08  replication-and-read-consistency     not yet exercised in DB sense; the
                                          per-instance divergence problem IS
                                          load-bearing (named in 08)
  09  database-systems-red-flags-audit    ranked risks given today's design
```

Read **01**, **06**, and **09** if you only have fifteen minutes — together they cover the honest picture (where state lives, where it can race, where it would bite).

## the actually-applicable sections

The list of "what's exercised" is short:

- **01 — database-systems-map.** The full layout above is real, and the lifetime hierarchy is what determines every other section's `not yet exercised` ranking.
- **06 — concurrency.** The MCP client's `lastCallAt` rate-limit counter is per-instance; that's the one real concurrency story.
- **08 — replication.** Not in the DB sense, but the per-instance divergence problem (insights Map A in instance 1 ≠ Map B in instance 2) is real and named.
- **09 — red flags.** Most findings are about state coordination, not engine tuning.

Sections 02 / 03 / 04 / 05 / 07 still read mostly as "what this would look like the day you needed it." They name the trigger and walk the concept generically with code-shaped pseudocode — no codebase anchor yet.

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
- No invented infrastructure. No claims about a database we don't have.
- Cross-links go to `study-system-design` (which engine you'd pick) and `study-data-modeling` (the shape of what you'd store), not re-taught here.

## see also

- `study-data-modeling` — the SHAPE of data, when you have any
- `study-system-design` — WHICH datastore, when you reach for one
- `study-runtime-systems` — Node process model; why `Map` is a per-process datastore
- `study-distributed-systems` — why per-instance caches diverge under load

---
Updated: 2026-06-19 — Olist SQLite tier removed (PR #8, commit 62c24d7). Synthetic data source landed (commit c75ec3e) and is in-process / no persistence. Verdict reverts to "no DB in this codebase"; sections 02/03/04/05/07 revert to "not yet exercised"; 10-embedded-sqlite-fixture retained with RETIRED banner.

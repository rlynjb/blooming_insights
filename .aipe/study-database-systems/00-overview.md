# Study — Database Systems (blooming insights)

## the verdict, before anything else

**blooming insights has no database.** Not a hidden one, not a "we use SQLite for dev." Zero. `package.json` lists no driver — no `pg`, `mysql2`, `sqlite3`, `redis`, `prisma`, `drizzle`, `mongoose`, `@upstash/*`. Nothing.

What it has instead, ranked by how close each gets to being database-shaped:

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

Bloomreach Engagement is the real data warehouse — multi-tenant, customer events, EQL query engine, the lot. We never touch it directly. We make MCP tool calls (`execute_analytics_eql`, `get_project_overview`) and stitch the results into insights. **The database concepts that matter to us are the ones that govern how we cache, dedupe, and trust those upstream responses — not how we shard tables.**

## why this guide exists anyway

Database-systems thinking still pays here. Three reasons:

1. The MCP cache **is** a tiny KV with TTL — single-writer, in-process, no eviction. That's a real datastore decision; understanding what it gives up (durability, cross-instance coherence, LRU) tells you exactly when it stops being enough.
2. The in-process `Map`s in `lib/state/insights.ts` look like state but **behave** like a single-writer table without persistence, without isolation, and without secondary indexes. Naming that shape is what tells you when "feed of insights" outgrows the file it lives in.
3. The day a feature lands that needs to survive a cold start — saved searches, per-user history, audit logs — you'll reach for Postgres. The teaching here primes you on which engine guarantees you'd be picking up, and which ones you'd be giving up.

So most sections will read **`not yet exercised`** — and each names the trigger that flips the verdict.

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
  │  │ minIntervalMs=1100 (rate limit)    │  └────────────────────────────┘ │
  │  └────────────────────────────────────┘                                 │
  │                                                                         │
  │  ┌─ lib/state/insights.ts ────────────┐  ┌─ lib/state/investigations.ts┐│
  │  │ insights: Map<id, Insight>         │  │ mem: Map<id, AgentEvent[]>  ││
  │  │ investigations: Map<id, Inv>       │  │ + .investigation-cache.json ││
  │  │ anomalies: Map<id, Anomaly>        │  │   (dev only)                ││
  │  │ — putInsights() does insights.clear()│ │ + demo-investigations.json  ││
  │  │   on every briefing run            │  │   (committed seed)          ││
  │  └────────────────────────────────────┘  └─────────────────────────────┘│
  │                                                                         │
  │  ┌─ lib/mcp/auth.ts ──────────────────────────────────────────────────┐ │
  │  │ dev: .auth-cache.json    test: memStore Map    prod: bi_auth cookie│ │
  │  │ AES-256-GCM under AUTH_SECRET (prod)                               │ │
  │  └────────────────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────┬───────────────────────────────────┘
                                        │  every read crosses the network
  ┌─ Bloomreach Engagement (upstream — somebody else's database) ───────────┐
  │  customer profiles · event streams · catalogs · EQL query engine        │
  │  exposed to us as MCP tools: execute_analytics_eql, get_event_schema… │
  │  rate-limited globally per user: 1 req per ~1s, sometimes 1 per 10s   │
  └─────────────────────────────────────────────────────────────────────────┘
```

Every persistent byte you can point at is either (a) a cookie, (b) a JSON file used in dev, or (c) committed demo fixtures. Production has nothing the next deploy doesn't reset.

## what to read first (and why)

```
  reading order — verdict-first

  01  database-systems-map           ← the only mostly-applicable section.
                                       what's where, what's not, the seams.

  02  records-pages-and-storage-layout    not yet exercised — Map ≠ pages
  03  btree-hash-and-secondary-indexes    not yet exercised — Map.get is O(1) hash
                                          and there are no secondary indexes
  04  query-planning-and-execution         not yet exercised — EQL planning happens
                                          inside Bloomreach, not here
  05  transactions-isolation-and-anomalies not yet exercised — no transactions exist
  06  locks-mvcc-and-concurrency-control   not yet exercised — single-writer-per-
                                          instance Maps; concurrent writers WILL
                                          conflict on Vercel (named, see 06)
  07  wal-durability-and-recovery          not yet exercised — nothing durable to log
  08  replication-and-read-consistency     not yet exercised — single source upstream,
                                          per-instance caches CAN diverge (named, see 08)
  09  database-systems-red-flags-audit    ranked risks for what IS here
```

Read **01** and **09** if you only have ten minutes — together they're the honest picture. Everything in between teaches the concept and names the trigger that would make it relevant.

## the somewhat-applicable handful

Two-and-a-half sections actually have teeth here:

- **01 — database-systems-map.** The full layout above is real. The MCP cache, the schema singleton, the state Maps, the auth backends — these are the storage substrate. Section 01 walks each.
- **06 — concurrency.** No locks, no MVCC — but `putInsights()` calls `insights.clear()` then re-fills. On Vercel with >1 warm instance, two concurrent briefings interleave clear and set and you can see torn state. That's a real concurrency-control gap, named honestly.
- **08 — replication and read consistency.** No replicas. But each warm Vercel instance has its OWN cache and its OWN `Map` of insights. Two users hitting two instances see two truths. That's not "replication lag" — it's "no shared store at all" — but it's the same family of read-consistency problem and worth naming.

The rest are honest `not yet exercised` notes with a "becomes relevant when…" trigger.

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
- No invented infrastructure. No "we use Postgres for…" — we don't.
- Cross-links go to `study-system-design` (which engine you'd pick) and `study-data-modeling` (the shape of what you'd store), not re-taught here.

## see also

- `study-data-modeling` — the SHAPE of data, were we to persist any
- `study-system-design` — WHICH datastore, when you reach for one
- `study-runtime-systems` — Node process model, why `Map` is single-writer here
- `study-distributed-systems` — why per-instance caches diverge under load

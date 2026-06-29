# Database systems — red flags audit

Industry standard · Audit artifact

## Zoom out — what an audit looks for vs what's here

Most database-system audits walk the lens inventory looking for missing pieces: where's the index, where's the migration story, where's the backup, where's the replication lag monitor. This codebase has **none of them — and that is the architecturally correct answer for what this product is.**

```
  Zoom out — the persistence floor of this repo

  ┌─ Service / agent layer ─────────────────────────────────────┐
  │  /api/briefing  /api/agent  monitoring/diagnostic/recommend  │
  └─────────────────────────────┬───────────────────────────────┘
                                │  reads + writes "state"
  ┌─ "Persistence" ─────────────▼───────────────────────────────┐
  │  Map<sessionId, SessionFeed>      in-memory, per-process     │
  │  Map<insightId, AgentEvent[]>     in-memory, per-process     │
  │  Map<key, {result, expiresAt}>    TTL cache, per-instance    │
  │  .investigation-cache.json        dev-only file              │
  │  .auth-cache.json                 dev-only file              │
  │  demo-*.json                      committed snapshot         │
  └──────────────────────────────────────────────────────────────┘
                                │  THE REAL DATASTORE IS UPSTREAM
                                ▼
  ┌─ Provider ──────────────────────────────────────────────────┐
  │  Bloomreach Engagement                                       │
  │  events, customers, catalogs — queried via EQL through MCP   │
  └──────────────────────────────────────────────────────────────┘
```

So the audit framing flips. We're not asking "where's the missing index" — we're asking "is the *absence* of a datastore the right call, and what does the absence cost?"

The verdict for the headline finding is the one you should remember: **no DB is the right call today; the costs are concrete and acceptable for the current product shape.**

## The lens inventory — verdicts in one line

```
  lens                                       verdict

  datastore selection                        not yet exercised — no DB by design
  records / pages / storage layout           not yet exercised — the only "table" is a Map
  indexes (B-tree / hash / secondary)        not yet exercised — single hash index = a Map
  query planning + execution                 not yet exercised — no SQL planner
  transactions / atomicity                   not yet exercised — no multi-row write
  isolation levels / anomalies               not yet exercised — single-process state
  locks / MVCC / concurrency control         not yet exercised — last-write-wins per session
  WAL / durability / recovery                NOT durable — restart wipes state by design
  backups / restore                          not yet exercised — nothing to back up
  replication / read consistency             not yet exercised — demo snapshot ≈ frozen replica
  migrations / schema evolution              not yet exercised — TypeScript types are the schema
  connection pooling / resource limits       not yet exercised — no pool
```

Every "not yet exercised" above is **honest, not aspirational.** The codebase has not implemented these because it does not need them. Adding any one of them is a product decision (we now own canonical user state) before it is an engineering decision.

## Ranked findings — what's load-bearing and what would change the call

Findings are ordered by the *consequence* of the architectural decision, not the surface scariness. F1 is the headline; F2–F5 are the consequences you accept by holding F1; F6–F8 are the things to watch for that *would* tip the call.

---

### F1 — No datastore is owned by this codebase  ·  verdict: correct today

**What's there.** Zero local DB. All canonical data (events, customers, catalogs, revenue) lives in Bloomreach Engagement, accessed via the loomi connect MCP server with EQL. Local "state" is `Map<sessionId, SessionFeed>` at `lib/state/insights.ts:14` and `Map<insightId, AgentEvent[]>` at `lib/state/investigations.ts:11`, plus the 60s TTL response cache on `BloomreachDataSource` at `lib/data-source/bloomreach-data-source.ts:122`.

**Why it's right.** The product is a *client* of someone else's datastore. It computes anomalies → diagnoses → recommendations on every run; it doesn't promise the user that any of those persist across browser sessions. Adding Postgres would mean either duplicating Bloomreach data or inventing a product concept (saved investigations, dashboards, multi-tenant configs) that doesn't exist.

**The costs you've accepted.** F2 through F5 below.

**What would change the call.** A product surface that requires user-owned canonical state (saved + shared briefings, an audit log, multi-user collaboration, scheduled monitoring with history). None of those exist today.

---

### F2 — State is wiped on every cold start  ·  verdict: acceptable

**What's there.** `Map<sessionId, SessionFeed>` lives in the Node process heap. A Vercel serverless function spins up cold, holds state in memory while warm, then dies. There is no WAL, no checkpoint, no restore path. `lib/state/insights.ts:14` (the outer map) is never persisted in production.

**Why it's right.** Every `/api/briefing` run is a *full re-computation* against Bloomreach. There is no information in the local Map that can't be regenerated by running the briefing again. State-loss-on-restart is fine because state-of-record never lived locally.

**The cost.** A user who walks away and comes back to a cold instance has to re-run the briefing (or land on the demo snapshot, which is the design's escape hatch — see F8). That's a UX cost, not a correctness cost.

**What would change the call.** The day a briefing run is *not* repeatable — e.g., because the agent's reasoning trace is itself the artifact users want to keep — durability becomes load-bearing. → see `07-wal-durability-and-recovery.md`.

---

### F3 — Concurrent writes can interleave with no isolation guarantee  ·  verdict: contained by session-keying

**What's there.** Two concurrent requests on the same warm instance touching the same session both see the same `Map`. `putInsights` at `lib/state/insights.ts:64-71` clears the session's sub-maps and re-populates them in a tight synchronous loop. A second `putInsights` arriving mid-loop would *not* corrupt the first (single-threaded JS event loop), but could produce a "torn" briefing where the user sees the second run's clear before the second run's writes.

**Why it's contained.** Each session has its own sub-feed (`SessionFeed` at `lib/state/insights.ts:8-12`). One user's concurrent runs are the only path to a collision, and the UI doesn't drive two concurrent briefings — the briefing button is disabled while a run is in flight (`useBriefingStream`).

**The cost.** A determined retry-spammer on one session could see a flickering feed. No data corruption, no cross-user leak.

**What would change the call.** A second instance serving the same session (Vercel doesn't pin sessions to instances — concurrent requests CAN land on different processes, which means the partition boundary IS the in-memory Map: instance A and instance B simply don't see each other's writes). The current shape leans on the briefing always being a *full re-compute*, so divergence resolves itself on the next run. The day a partial-update pattern lands, we need actual concurrency control. → see `06-locks-mvcc-and-concurrency-control.md`.

---

### F4 — The 60s TTL cache can return stale Bloomreach data  ·  verdict: deliberate; documented

**What's there.** `BloomreachDataSource` caches every successful tool result by `${name}:${JSON.stringify(args)}` for 60 seconds (`lib/data-source/bloomreach-data-source.ts:122,144-148,185-187`). Two identical EQL queries within the window return identical results — even if the underlying Bloomreach data has changed.

**Why it's right.** Bloomreach rate-limits at ~1 req/s globally per user. An agent that asks "purchase count in last 90d" three times during one investigation would burn three rate-limit slots for no information gain. The cache absorbs that.

**The cost.** A briefing kicked off 30 seconds after a previous one returns mostly-cached numbers. For 90-day windows that move by minutes, that's invisible. For tighter-window queries it would not be.

**What would change the call.** Any per-call TTL override that drops below the metric's actual freshness budget. The cache is the right shape; the TTL choice is where you'd tune. → see `08-replication-and-read-consistency.md` for the stale-read framing; `study-system-design`'s caching pattern file for the operational details.

---

### F5 — The demo snapshot is a committed, frozen "read replica"  ·  verdict: load-bearing for demos; explicitly versioned

**What's there.** `lib/state/demo-insights.json` (665 lines) and `lib/state/demo-investigations.json` (3487 lines) are *committed* JSON files that mirror one captured live run end-to-end. The demo path in `/api/briefing` and `/api/agent` reads from these files instead of running the agents. Investigations are read by `lib/state/investigations.ts:9,26` (the `DEMO_FILE` constant).

**Why it's right.** The alpha MCP server revokes tokens after minutes; running live during a demo is unreliable. A frozen, replayable artifact IS the reliable presentation path. Treating it as a *read replica* (deterministic, no lag, no failover, but also no freshness) is the right mental model.

**The cost.** The snapshot drifts from production reality every day it isn't recaptured. The dev-only one-click capture script at `app/page.tsx` is the "refresh the replica" command — but nothing automates it.

**What would change the call.** A demo where stale data is itself the bug (a metric the user knows just moved). Today the demo is *illustrative*, not a live mirror, and the UI never claims it's fresh.

---

### F6 — No migration story exists  ·  verdict: not needed yet; will be the first real cost if F1 changes

**What's there.** The "schema" is TypeScript: `Insight`, `Anomaly`, `Diagnosis`, `Recommendation`, `WorkspaceSchema` in `lib/mcp/types.ts` and `lib/mcp/schema.ts`. New fields are added by editing the type and validator; old demo snapshots are accommodated by keeping new fields *optional* (project context spec, "What must not change").

**Why it's right today.** No on-disk persistence means no migration. The only "stored" data is the committed demo snapshots, and the optional-field convention handles forward-compat.

**The cost.** None today. The day a real datastore lands, the cost of *not having* a migration system shows up immediately — and the rest of the codebase will not have built any muscle for it.

**What would change the call.** F1 changing. Until then, this is a watch-item, not a fix-item.

---

### F7 — No connection pool, no resource limits, no query-budget tracking  ·  verdict: not needed; provider-side limits do the work

**What's there.** No `pg.Pool`, no Redis client, no DB connection lifecycle. The closest thing to a "connection" is the MCP transport, which is created per-session in `lib/mcp/connect.ts` and reused for the session's lifetime. Resource limiting is delegated to the provider: Bloomreach rate-limits at ~1 req/s, and the data source enforces a `minIntervalMs` of 200 (`lib/data-source/bloomreach-data-source.ts:130`) to stay under it.

**Why it's right.** Without a DB, there's no pool to manage. The provider IS the resource boundary.

**The cost.** None today. The same caveat as F6 — none of the muscle exists locally for the day it's needed.

---

### F8 — Dev-only file persistence is gitignored and not auditable  ·  verdict: dev convenience; not load-bearing

**What's there.** `.investigation-cache.json` and `.auth-cache.json` exist in development only (`lib/state/investigations.ts:7` and `lib/mcp/auth.ts:34`). Production uses an encrypted httpOnly cookie for OAuth state and in-memory only for investigations. Both files are gitignored.

**Why it's right.** Next's dev server re-evaluates modules on hot-reload — an in-memory Map would wipe the OAuth/PKCE state mid-flow. The file store survives. Production doesn't hot-reload, so the cookie/Map split is the right one.

**The cost.** A developer's local cache can hold stale auth or stale investigations across restarts. The fix is `rm .investigation-cache.json` — which is documented behavior, not a bug.

---

## How to read this audit in a year

If F1 still says "no DB by design," the rest of these findings still hold and this guide is still teaching mostly Case-B material. If F1 flips — the product gains user-owned canonical state — then F6, F7, and most of the concept files move from Case B to Case A, and this audit becomes the bridge document for the migration. The concept files in this guide are written to make that day a vocabulary refresher, not a re-learning.

# Database Systems — overview

This repo has **no database.** That sentence is the whole map.

Nothing on disk owns rows. Every "stored" thing in blooming insights is one of three things: an in-memory `Map` that vanishes when the Node process restarts, a 60-second TTL response cache that absorbs repeat tool calls during a single briefing, or a JSON file that was hand-baked once and committed to git. The one piece of state that genuinely survives a process death lives in an encrypted HTTP cookie — the OAuth tokens for the Bloomreach MCP session.

That's the database story. The rest of this guide takes the industry vocabulary you would use to reason about a real storage engine — tables, indexes, transactions, isolation, WAL, replicas — and asks the only honest question: *which of these mechanisms does this codebase actually exercise, and where are the analogs that stand in for the absent ones?*

## Zoom out — where data lives

```
  Where the data lives in this repo — not on disk

  ┌─ Process memory (warm Vercel instance) ────────────────────┐
  │  sessionState: Map<sessionId, { insights, investigations,  │
  │                                  anomalies }>              │
  │  cache: Map<"tool:args", { result, expiresAt }>            │
  │  └─ both die on cold start / instance recycle              │
  └──────────────────────────┬─────────────────────────────────┘
                             │  read on the next request
  ┌─ Filesystem (build artifact, read-only at runtime) ────────┐
  │  lib/state/demo-insights.json                              │
  │  lib/state/demo-investigations.json                        │
  │  └─ committed snapshot, served as JSON in demo mode        │
  └──────────────────────────┬─────────────────────────────────┘
                             │  encrypted, sent back per-request
  ┌─ Browser cookie (the only true durability) ────────────────┐
  │  bi_auth: AES-256-GCM(Store) under AUTH_SECRET             │
  │  └─ OAuth tokens survive deploys, instance churn, restarts │
  └────────────────────────────────────────────────────────────┘
```

## The ranked findings

What's actually consequential, in order:

1. **There is no durability for user data.** A Vercel instance recycle wipes every active briefing, every cached tool result, every in-flight investigation. The only thing protected from that is the OAuth cookie. (See `01-database-systems-map.md` for the full inventory.)

2. **The session table is partitioned the right way.** `lib/state/insights.ts:14` keys an outer `Map<sessionId, SessionFeed>` so one user's `clear()` cannot wipe another user's feed. The comment on lines 5-7 explains the bug a module-level Map would have caused. This is the load-bearing primary-key choice in the whole repo. (See `02-records-pages-and-storage-layout.md`.)

3. **The 60s response cache is the only index-like structure.** `lib/data-source/bloomreach-data-source.ts:144` builds a string key `${name}:${JSON.stringify(args)}` and stores results in a `Map`. That's a hash index in everything but name — same lookup pattern, same write-on-miss behavior. (See `03-btree-hash-and-secondary-indexes.md`.)

4. **No transactions exist anywhere, and there's exactly one place where that's risky.** `putInsights` (`lib/state/insights.ts:57`) does `s.insights.clear()` followed by `items.forEach(...)`. If the process dies between those two lines, the session's feed is half-replaced. Not currently a real risk — there's no failure between them — but it's the only multi-step write in the codebase. (See `05-transactions-isolation-and-anomalies.md`.)

5. **The demo snapshot is a frozen read replica.** `public/demo/` doesn't exist; the snapshot lives at `lib/state/demo-insights.json` (665 lines) and `demo-investigations.json` (3,487 lines). Demo mode bypasses the agents entirely and streams the file back as NDJSON. This is a read-only replica with no replication lag because there's nothing to replicate from. (See `08-replication-and-read-consistency.md`.)

6. **The auth cookie is the only real durability story.** AES-256-GCM under `AUTH_SECRET`, AsyncLocalStorage-scoped per request, written through `withAuthCookies` (`lib/mcp/auth.ts:86`). This is the closest thing to a WAL the repo has — an explicit dirty bit, a single flush per request, crypto for integrity. (See `07-wal-durability-and-recovery.md`.)

7. **MVCC and locks aren't exercised because there's no shared mutable state across requests within a session.** A single warm instance can serve concurrent requests for different sessions — those are partition-isolated by sessionId. Concurrent requests for the *same* session are possible (e.g. step 2 and step 3 of an investigation racing) but operate on different sub-maps. (See `06-locks-mvcc-and-concurrency-control.md`.)

## Reading order

```
  01-database-systems-map.md        the inventory of every storage analog
  02-records-pages-and-storage-layout.md   how a session is laid out, why
  03-btree-hash-and-secondary-indexes.md   the 60s cache as a hash index
  04-query-planning-and-execution.md       EQL planning happens server-side
  05-transactions-isolation-and-anomalies.md   the one multi-step write
  06-locks-mvcc-and-concurrency-control.md     why no locks are needed yet
  07-wal-durability-and-recovery.md            the auth cookie story
  08-replication-and-read-consistency.md       the demo snapshot
  09-database-systems-red-flags-audit.md       ranked risks
```

## `not yet exercised` — what's honestly absent

- **B-tree or LSM indexes.** No persisted storage = no persisted index.
- **Query planner / EXPLAIN.** The agents emit EQL strings that the Bloomreach server plans and executes. We have zero visibility into the plan.
- **Real transactions / ACID.** No store supports them. The one multi-step write is documented in `05`.
- **Real MVCC.** `Map` provides no version chain; the JSON snapshot is single-version on disk.
- **Replication lag.** The committed snapshot is a build artifact, not a streaming replica.
- **Backups / restore / PITR.** The auth cookie is the only thing whose loss has user-visible cost — and "restoring" it means re-running the OAuth dance.

If any of these become real (the repo grows a Postgres, a Redis, a Durable Object), this guide gets re-written from `01` forward. Until then: the absence IS the lesson.

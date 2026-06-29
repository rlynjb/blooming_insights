# Study — Database Systems

This guide treats database-engine mechanisms (storage layout, indexes, query execution, transactions, isolation, concurrency, durability, recovery, replication) as a foundation discipline you should be able to reason about — even though **this codebase exercises none of them.**

The product is a multi-agent Bloomreach Engagement client. The real datastore lives at the provider. Locally, "persistence" is `Map<sessionId, ...>` in heap, a TTL cache on the data-source adapter, gitignored JSON in dev, and committed demo snapshots. Every concept file teaches the pattern as it exists in industry, then anchors back to *whichever local analog is closest* — so the reader leaves with both the vocabulary and a fair read on what this repo isn't.

## Reading order

1. [`00-overview.md`](./00-overview.md) — system map and the "no DB by design" call
2. [`01-database-systems-map.md`](./01-database-systems-map.md) — the datastore map, engine choices, durability boundaries
3. [`02-records-pages-and-storage-layout.md`](./02-records-pages-and-storage-layout.md) — records, pages, locality
4. [`03-btree-hash-and-secondary-indexes.md`](./03-btree-hash-and-secondary-indexes.md) — index structures and lookup behavior
5. [`04-query-planning-and-execution.md`](./04-query-planning-and-execution.md) — plans, scans, joins, N+1
6. [`05-transactions-isolation-and-anomalies.md`](./05-transactions-isolation-and-anomalies.md) — atomicity, isolation levels, anomalies
7. [`06-locks-mvcc-and-concurrency-control.md`](./06-locks-mvcc-and-concurrency-control.md) — locks, MVCC, conflicts
8. [`07-wal-durability-and-recovery.md`](./07-wal-durability-and-recovery.md) — write-ahead logs, backups, restore
9. [`08-replication-and-read-consistency.md`](./08-replication-and-read-consistency.md) — replicas, lag, failover
10. [`audit.md`](./audit.md) — ranked red flags grounded in this repo

## The three local analogs you'll see referenced everywhere

```
  the engine concern                the local analog it lands as

  table                             Map<sessionId, SessionFeed>
    keyed lookup with namespace       (lib/state/insights.ts:14)
    no schema, no index, no durability

  TTL cache                         response cache on BloomreachDataSource
    single-shot per-key with expiry   (lib/data-source/...:122,144)
    the cache layer ABOVE a database

  read replica (frozen)             demo-*.json (committed)
    one captured run, deterministic   (lib/state/demo-*.json)
    no lag, no failover
```

Each concept file pulls the one that matches.

## Cross-links to neighboring guides

  - The provider boundary, caching, rate-limit retry, and where which datastore is *selected* live in `.aipe/study-system-design/`.
  - The shape of the data (the `Insight`, `Anomaly`, `Diagnosis`, `Recommendation` types — what would be tables) belongs in `.aipe/study-data-modeling/`.
  - Tool usage, EQL choice, and the agent's reasoning over the data belong in `.aipe/study-ai-engineering/`.

## How to use this guide

If you joined this codebase to ship features, you can largely skip it — the persistence story today is "a Map and a cache." Open it when:

  - You're prepping for a system-design interview and need DB-engine vocabulary back in working memory.
  - The team starts talking about adding state of its own (saved investigations, multi-tenant config, audit log) and someone asks "Postgres or a managed KV or a serverless DB?" — the audit and the WAL/replication files frame the choice.
  - A teammate proposes "let's cache more aggressively" and you want to be honest about which read-consistency guarantees you're trading.

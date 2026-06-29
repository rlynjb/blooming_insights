# Database Systems — overview

Industry standard discipline · Curriculum guide

## Zoom out — where database systems would live in this repo

Most full-stack apps have a real datastore sitting under the service layer. This one does not. The persistence floor in this repo is in-memory `Map`s plus committed JSON snapshots — the engine layer of a database (records, pages, indexes, WAL, MVCC, replicas) is *absent by design*.

```
  Zoom out — where the datastore would sit (and what's there instead)

  ┌─ UI layer ──────────────────────────────────────────────────┐
  │  Next.js App Router · React 19 · sessionStorage / localStorage│
  └───────────────────────────────┬──────────────────────────────┘
                                  │  fetch + NDJSON
  ┌─ Service layer ───────────────▼──────────────────────────────┐
  │  /api/briefing  /api/agent  /api/mcp/*                        │
  │  agents: monitoring · diagnostic · recommendation · query     │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  callTool(name, args, signal)
  ┌─ Adapter layer ───────────────▼──────────────────────────────┐
  │  DataSource interface  →  BloomreachDataSource                │
  │  ▲ 60s response cache · ~1 req/s · retry ladder              │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  MCP over HTTP (OAuth/PKCE)
  ┌─ Provider ────────────────────▼──────────────────────────────┐
  │  Bloomreach Engagement (loomi connect MCP server)             │
  │  the real datastore — owned, governed, queried OUT of repo    │
  └───────────────────────────────────────────────────────────────┘

  ┌─ Local "persistence" ─── you-are-here for this guide ────────┐
  │  Map<sessionId, SessionFeed>   (lib/state/insights.ts:14)     │
  │  Map<insightId, AgentEvent[]>  (lib/state/investigations.ts:11)│
  │  Map<key, {result, expiresAt}> (BloomreachDataSource:122 — TTL)│
  │  .investigation-cache.json     (dev-only read-through)         │
  │  .auth-cache.json              (dev-only OAuth state)          │
  │  lib/state/demo-*.json         (committed "read replica")      │
  └───────────────────────────────────────────────────────────────┘
```

Read that bottom band again. That's the substrate this guide is about. There's no Postgres, no Redis, no embedded engine, no vector store. The "database" is a `Map` that lives in one process's heap, plus some JSON files for development and demo.

## The verdict — `no datastore` is a deliberate architectural choice

Before we walk the mechanisms, the call: **this codebase has no DB substrate, and that's correct for what it is.** The product is an agent that *queries someone else's datastore* (Bloomreach Engagement) and shapes the answers. It owns no canonical data of its own. Adding Postgres would mean either:

  - duplicating data that already lives in Bloomreach, or
  - inventing user-owned state (saved investigations, multi-tenant configs) that doesn't exist yet as a product concept.

Neither exists today. So every classical DB concept in this guide — pages, B-trees, transactions, WAL, MVCC, replication — lands as **Case B: not yet exercised in this repo; here's the pattern and where it would land if it were.** That's not a gap. It's a deliberate boundary the architecture maintains.

## What this guide teaches anyway

Two reasons to walk these concepts even when the repo doesn't exercise them:

  1. **Recognition.** When you join a team with a real DB, you need to recognize what you're looking at — a B-tree, a serializable transaction, a write-ahead log, a replica lagging. The vocabulary transfers; the mechanism does not change because your codebase doesn't run one.

  2. **Honest analogs.** Three things in this repo *gesture at* DB engine concerns without being one. They're useful to study because they isolate one engine concern at a time:

     - the **table** (the per-session `Map<sessionId, ...>`): a keyed lookup with namespacing
     - the **TTL cache** (the BloomreachDataSource response cache): a single-shot per-key store with expiry that absorbs repeated reads
     - the **read replica** (the committed `demo-*.json`): a frozen snapshot of one live run, replayed deterministically

## The concept inventory — and where each one lands

```
  the nine concepts                          status in this repo

  1. database-systems-map               →    Case B (no DB)
  2. records-pages-and-storage-layout   →    Case B (Map ≈ heap "table")
  3. btree-hash-and-secondary-indexes   →    Case B (Map = hash index only)
  4. query-planning-and-execution       →    Case B (no SQL plan; EQL planned upstream)
  5. transactions-isolation-and-anomalies→   Case B (no atomic multi-write)
  6. locks-mvcc-and-concurrency-control →    Case B (single-process, last-write-wins)
  7. wal-durability-and-recovery        →    Case B (no durability — restart loses state)
  8. replication-and-read-consistency   →    Case B (demo snapshot ≈ frozen read replica)
  9. database-systems-red-flags-audit   →    "no DB by design" — see audit.md
```

Every concept file opens with the standard zoom-out, walks the pattern as it would appear in a real engine, then anchors back to *what this repo does instead* — usually one of the three analogs above.

## Reading order

```
  start here  →  01-database-systems-map           the map (no DB on it; that's the point)
                 02-records-pages-and-storage-layout  the "table" lives in heap
                 03-btree-hash-and-secondary-indexes  Map = hash; nothing range-queryable
                 04-query-planning-and-execution     no SQL planner; EQL goes upstream
                 05-transactions-isolation-and-anomalies  no atomicity; what could break
                 06-locks-mvcc-and-concurrency-control     concurrency is single-process
                 07-wal-durability-and-recovery     restart = state lost (by design)
                 08-replication-and-read-consistency  demo snapshot as a "read replica"
                 end with  →  audit.md            ranked findings; "no DB" is finding #1
```

`README.md` is the table of contents. `audit.md` is the ranked red-flags walk — the one to open if you're prepping to defend the architecture in an interview.

## What this guide does NOT cover

  - **Bloomreach's own engine.** What Bloomreach uses to store events and run EQL is its problem. We're a client. → see `study-system-design` for the provider boundary.
  - **The query shape itself** (EQL, time windows, period-over-period). → see `study-data-modeling` for the data shape; `study-ai-engineering` for how the agent decides which queries to run.
  - **Caching strategy details** (TTL choice, invalidation). → see `study-system-design`'s caching-and-rate-limiting pattern file. Here we only treat the cache as the closest local analog to a "datastore."

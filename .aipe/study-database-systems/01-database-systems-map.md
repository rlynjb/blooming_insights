# Database systems map

Industry standard · Orientation diagram

## Zoom out — what a "DB systems map" usually shows, and what it shows for this repo

In a normal architecture review, the database systems map is the layered picture of *which datastore answers which query, what its durability boundary is, and where the read path goes.* For most apps that's three to seven boxes (primary OLTP, OLAP warehouse, cache, search index, queue store, vector index, ...). For this repo the map has **one real datastore — and it's not yours.**

```
  Zoom out — the datastore map for this codebase

  ┌─ UI layer ──────────────────────────────────────────────────┐
  │  React 19 (App Router)                                        │
  │  sessionStorage: bi:insight:<id>, bi:diag:<id> (client-side)  │
  │  localStorage:   bi:mode (demo|live)                          │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ fetch + NDJSON
  ┌─ Service layer ───────────────▼──────────────────────────────┐
  │  /api/briefing       /api/agent       /api/mcp/*              │
  │  reads: listInsights · getInsight · getInvestigation          │
  │  writes: putInsights · putInvestigation · saveInvestigation   │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ Map.get / Map.set
  ┌─ "State" layer (heap + dev FS) ▼─────────────────────────────┐
  │  ★ THE LOCAL "DATASTORE" ★                                    │
  │  Map<sessionId, SessionFeed>     insights.ts:14               │
  │  Map<insightId, AgentEvent[]>    investigations.ts:11         │
  │  Map<key, {result, expiresAt}>   bloomreach-data-source.ts:122│
  │  .investigation-cache.json       (dev only)                   │
  │  .auth-cache.json                (dev only)                   │
  │  demo-*.json                     (committed snapshot)         │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  callTool(name, args)
  ┌─ Adapter layer ───────────────▼──────────────────────────────┐
  │  DataSource interface  →  BloomreachDataSource                │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  MCP / HTTP / OAuth+PKCE
  ┌─ Provider ────────────────────▼──────────────────────────────┐
  │  Bloomreach Engagement (loomi connect MCP server)             │
  │  THE REAL DATASTORE — events, customers, catalogs, revenue   │
  │  queried via EQL; durability + indexes + ACID owned upstream  │
  └───────────────────────────────────────────────────────────────┘
```

## Zoom in — the question this concept answers

When someone asks "what's the database story for this app?" — the answer is the map above. The honest map. Three things matter on it:

  1. The **canonical datastore is Bloomreach**, not anything in this repo.
  2. The **local "state" layer is in-memory heap plus opt-in dev files** — it owns nothing of record.
  3. The **demo snapshot is committed JSON**, not a replica of anything live.

## Structure pass — the skeleton

Three layers, one axis traced across them.

### Layers
  - **Provider** — Bloomreach. The canonical store. Has its own engine, indexes, durability, replication. Opaque to us.
  - **Adapter + cache** — `BloomreachDataSource`. A keyed expiring cache in front of the provider. No durability of its own.
  - **App state** — `Map`s in the Next process heap + dev JSON files. Volatile by design.

### Axis: who owns the data of record?

```
  The "ownership" axis, traced down the stack

  ┌─ Provider ─────────────────────┐
  │  OWNS canonical data of record │   ← record-of-truth lives here
  └────────────────────────────────┘
       ┌─ Adapter + cache ──────────┐
       │  HOLDS a 60s recent copy   │   ← derivative; cache only
       └────────────────────────────┘
            ┌─ App state ───────────┐
            │  HOLDS computed views │   ← derivative; throw away anytime
            │  (Insight, Diagnosis) │
            └───────────────────────┘
```

Every layer below the provider is *derivative*. None of them are allowed to be the only place a fact lives. That single invariant is what makes "no DB by design" safe.

### Seams (where the axis flips)

  - **Provider ↔ adapter seam.** Ownership flips here from "record" to "cached copy." Crossing it without going through the adapter (and its cache + rate limit) means hitting Bloomreach at full rate — which is forbidden.
  - **Adapter ↔ app-state seam.** Ownership flips here from "cached copy of real data" to "computed result of running the agent over that data." Insights and investigations are *derivations*, not data of record. They are throwaway on purpose.

## How it works

### Move 1 — the mental model

If you've ever shipped a Next.js app that calls a third-party API, you already know the shape: API → fetch cache → React state. This is that shape, with names attached.

```
  The shape — three-tier derivative pipeline

  ┌─ provider ─┐  freshness
  │ canonical  │  ▲
  └─────┬──────┘  │
        │ EQL    │
  ┌─ adapter ──┐  │  data ages as you go DOWN the stack
  │ 60s cache  │  │  liveness ages as you go DOWN the stack
  └─────┬──────┘  │  ownership stays UP at the provider
        │        │
  ┌─ app state ┐  ▼
  │ computed   │  oldest
  └────────────┘
```

That's the whole map. Every concept file in this guide picks one layer of that picture and asks "what would a database engine do here?" — and answers "we don't, because the engine lives upstream."

### Move 2 — the layer-by-layer walkthrough

#### Provider (Bloomreach Engagement)

The canonical datastore. We don't see its engine. We send EQL ("execute analytics EQL") and it returns rows. From the outside, we treat it as having strong consistency for our purposes — the agent doesn't run two queries and rely on them being a consistent snapshot of the same instant; it runs sequential queries and reasons over what comes back.

```
  Provider boundary — opaque from this side

  ┌─ this repo ─────┐         ┌─ Bloomreach ────────────┐
  │  agent          │  EQL   │  ? engine ? indexes ?    │
  │  callTool(...)  │ ─────► │  ? durability ?          │
  │                 │ ◄───── │  ? replicas ?            │
  └─────────────────┘ rows   └──────────────────────────┘
                              the answers live here; we don't see them
```

This is the entire reason every concept file below it is Case B for *us*. The mechanism exists, it just doesn't live in our codebase.

#### Adapter layer — `BloomreachDataSource` with TTL cache

This is the closest thing in the repo to a "database engine concern" — a keyed store with expiry. Read-through on hit; rate-limited fetch + cache-fill on miss.

```ts
// lib/data-source/bloomreach-data-source.ts:122
private cache = new Map<string, { result: unknown; expiresAt: number }>();
// ...
// lib/data-source/bloomreach-data-source.ts:144-152
const cacheKey = `${name}:${JSON.stringify(args)}`;
const ttl = options.cacheTtlMs ?? 60_000;

if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

Annotation:
  - **Line 122** — the cache is a `Map`; key is `name + JSON-stringified args`; value carries an `expiresAt` epoch ms. No LRU, no size cap, no eviction other than expiry-on-read.
  - **Line 145** — TTL default is 60s. The agent never overrides; only `/api/mcp/capture` and debug tooling do.
  - **Lines 148-151** — read-through: if a non-expired entry exists, return it tagged `fromCache: true`. The `durationMs: 0` flows out to the UI's tool-call trace.

This pattern recurs in real databases at the buffer-pool layer (DB pages cached in memory) and at the materialized-view layer (precomputed query results cached with invalidation). Here it's the only cache; there's no engine below it, just HTTP to the provider.

#### App-state layer — namespaced tables (session-keyed `Map`s)

The two state files are deliberately shaped like *namespaced tables.* The namespace (the outer `Map`) partitions by sessionId; the tables (the inner `Map`s) hold the rows.

```ts
// lib/state/insights.ts:8-23
type SessionFeed = {
  insights: Map<string, Insight>;
  investigations: Map<string, Investigation>;
  anomalies: Map<string, Anomaly>;
};

const state = new Map<string, SessionFeed>();

function sessionState(sessionId: string): SessionFeed {
  let s = state.get(sessionId);
  if (!s) {
    s = { insights: new Map(), investigations: new Map(), anomalies: new Map() };
    state.set(sessionId, s);
  }
  return s;
}
```

Annotation:
  - **Lines 8-12** — `SessionFeed` is the per-session set of "tables." Three of them. Each is a hash-indexed lookup by primary key (`id` for insights and anomalies, `insightId` for investigations).
  - **Line 14** — `state` is the global outer Map. One entry per active session. It is *never* cleared by a request handler.
  - **Lines 16-23** — the DDL bootstrap (`USE database <sessionId>; CREATE TABLE IF NOT EXISTS ...`) is what `sessionState` is doing. Lazy initialization, no schema migration, no real DDL.

Compare to a real RDBMS: replace `Map<sessionId, SessionFeed>` with `schema_<sessionId>` namespacing, the inner Maps become heap tables, and `Map.get`/`Map.set` become `SELECT WHERE id = ?` / `INSERT ... ON CONFLICT DO UPDATE`. Same shape, very different durability story.

#### Dev FS layer — read-through to JSON

Investigations have one extra trick: a *three-tier* read with the dev file in the middle.

```ts
// lib/state/investigations.ts:22-28
export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
  if (mem.has(insightId)) return mem.get(insightId)!;
  const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;
  if (fromFile) return fromFile;
  const fromDemo = readJson(DEMO_FILE)[insightId];
  return fromDemo ?? null;
}
```

Annotation:
  - **Line 23** — first hit the in-memory cache. This is the L1.
  - **Line 24** — in dev only, fall through to `.investigation-cache.json` on disk. This is the L2 — and the equivalent of a database's "cold storage" tier for the dev workflow specifically.
  - **Line 26** — fall through to the committed `demo-investigations.json`. This is the read replica — frozen at capture time, served identically across all sessions and instances.

That three-tier read IS the closest thing in this codebase to a tiered storage hierarchy.

### Move 3 — the principle

A database's job is to be *the place* a piece of data lives. The moment a system needs more than one place for the same datum — primary + replica, table + index, hot + cold, in-memory + on-disk — you've built a database engine, whether or not you call it one. This repo deliberately keeps the answer at one place (the provider) and treats every local copy as expendable. That's the cleanest possible architecture for a *client* of someone else's datastore.

## Primary diagram

```
  The full database systems map for this repo

  ┌─ UI / browser ────────────────────────────────────────────┐
  │  sessionStorage: bi:insight:<id> · bi:diag:<id>             │
  │  localStorage:   bi:mode                                    │
  └─────────────────────────────┬───────────────────────────────┘
                                │ fetch / NDJSON
  ┌─ App / service ─────────────▼───────────────────────────────┐
  │  routes: /api/briefing · /api/agent · /api/mcp/*             │
  │  agents: monitoring · diagnostic · recommendation · query    │
  └─────────────────────────────┬───────────────────────────────┘
                                │ Map.get / Map.set
  ┌─ Local state (heap + dev FS) ▼──────────────────────────────┐
  │  L0 in-mem  Map<sessionId, SessionFeed>     insights.ts:14   │
  │  L0 in-mem  Map<insightId, AgentEvent[]>    invest.ts:11     │
  │  L0 in-mem  Map<key, {result, expiresAt}>   ds:122 (60s TTL) │
  │  L1 dev-fs  .investigation-cache.json       (dev only)       │
  │  L1 dev-fs  .auth-cache.json                (dev only)       │
  │  L2 repo    demo-insights.json   demo-investigations.json    │
  └─────────────────────────────┬───────────────────────────────┘
                                │ callTool(name, args)
  ┌─ Adapter ───────────────────▼───────────────────────────────┐
  │  BloomreachDataSource: rate-limit · retry · cache · errors   │
  └─────────────────────────────┬───────────────────────────────┘
                                │ MCP over HTTP (OAuth+PKCE)
  ┌─ Provider ──────────────────▼───────────────────────────────┐
  │  Bloomreach Engagement (loomi connect MCP server)            │
  │  CANONICAL DATA OF RECORD                                    │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The "no DB by design" call is unusual but defensible. Three places it shows up in industry:

  - **Pure analytics frontends** over a warehouse you don't own — Looker, Mode, Hex. The visualization layer is stateless; the warehouse is the database.
  - **Agent frameworks** that wrap a third-party API — the agent's state is the conversation, the data is whoever's behind the tool calls.
  - **Edge-rendered marketing sites** with CMS-as-database — Sanity, Contentful. The CMS is the store; the frontend has no schema of its own.

What unites them: the product owns *behavior over someone else's data*, not data of its own. The minute that flips — first user-owned record — a real datastore lands. That's the inflection point F1 in `audit.md` is tracking.

## Interview defense

> Q: "Walk me through the data layer of this app."

Verdict first: this app has no datastore of its own. The canonical data lives in Bloomreach Engagement, accessed via EQL through an MCP server. Local "state" is three in-memory Maps — one for the per-session feed of insights, one for cached investigations, and a 60-second TTL response cache on the data-source adapter — plus committed demo snapshots that serve as a frozen replica for offline demos.

```
  the three-tier picture you draw while answering

  Bloomreach  ◄── EQL ──  Adapter (60s cache) ◄── Map.get ──  App state
   (record)                 (cached copy)               (computed views)
```

The single load-bearing invariant: every layer below the provider is *derivative*. Nothing in this repo is the only place a fact lives. That's what makes the absence of WAL, transactions, and replication a deliberate choice rather than a missing feature.

> Q: "Why no Postgres? Wouldn't that make a lot of this easier?"

It would make a *different* thing easier — a product where you save investigations across sessions, share them with teammates, audit them later. None of that is in the product today. Adding Postgres now means either duplicating Bloomreach (a sync problem) or building a product surface that doesn't exist yet. The right move is to keep the datastore-shaped hole vacant until product clarifies what canonical data we'd own.

> Q: "What's the worst thing that can happen with this no-DB shape?"

User loses their feed when the serverless instance recycles, and clicks "refresh" to recompute. That's a UX cost — not a correctness cost — because no information lived only in the local Map.

## See also

  - [`02-records-pages-and-storage-layout.md`](./02-records-pages-and-storage-layout.md) — what a "row" looks like when your table is a `Map`
  - [`07-wal-durability-and-recovery.md`](./07-wal-durability-and-recovery.md) — what "restart loses state" means in detail
  - [`audit.md`](./audit.md) — F1 "no DB by design" framing
  - `.aipe/study-system-design/` — the provider boundary, caching pattern, rate-limit retry

# The datastore map — every storage analog in the repo

*Industry standard / Project-specific* — there's no datastore; instead the repo composes four local analogs that collectively do the work a database would.

## Zoom out, then zoom in

Open this repo expecting a `db/` folder or a `prisma/schema.prisma` and you'll bounce around for an hour looking for the storage layer. There isn't one. The whole "datastore" is four places: two `Map` instances in process memory, a JSON file on disk, and a cookie in the user's browser. That's it.

```
  Zoom out — where this concept lives

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  app/page.tsx   →   fetch('/api/briefing')                │
  └────────────────────────────┬─────────────────────────────┘
                               │  HTTP
  ┌─ Service layer ────────────▼─────────────────────────────┐
  │  app/api/briefing/route.ts   →   ★ THE DATASTORE MAP ★    │ ← we are here
  │  - in-memory Map (session feed)                           │
  │  - 60s response cache                                     │
  │  - file read for demo snapshot                            │
  │  - encrypted cookie for OAuth tokens                      │
  └────────────────────────────┬─────────────────────────────┘
                               │
  ┌─ Storage layer ────────────▼─────────────────────────────┐
  │  process memory   ·   filesystem (RO)   ·   client cookie │
  │  (NO database)                                            │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: every concept that follows hangs off one of those four boxes. When this guide talks about "tables," "indexes," "transactions," "durability" — pick a box and ask "which of these is doing that job here?" Most of the time only one of them is, and often the answer is "nothing is, and here's why that's fine."

## Structure pass

The skeleton has four layers and one axis worth tracing.

**Layers:**

```
  L1  in-memory Map        process-scoped, dies on restart
  L2  60s response cache   process-scoped, time-bounded
  L3  filesystem JSON      read-only at runtime, committed to git
  L4  encrypted cookie     client-scoped, survives everything
```

**Axis traced: durability** — how long does a write survive?

```
  Trace one axis: how long does a write survive?

  ┌─ L1: in-memory Map ──────────────────┐
  │  putInsights → Map.set               │   → until process restart
  └──────────────────────────────────────┘
                  (it flips)
  ┌─ L2: response cache ─────────────────┐
  │  cache.set(key, { expiresAt })       │   → 60s OR process restart
  └──────────────────────────────────────┘
                  (it flips)
  ┌─ L3: filesystem (build) ─────────────┐
  │  git commit lib/state/*.json         │   → next deploy
  └──────────────────────────────────────┘
                  (it flips)
  ┌─ L4: bi_auth cookie ─────────────────┐
  │  withAuthCookies → set Secure cookie │   → 10 days (AUTH_COOKIE_MAX_AGE)
  └──────────────────────────────────────┘

  every boundary flips the answer — this is why the layers are real layers
```

**Seams** — three of them matter:

- The seam between L1 and L4 is the only one a user can cross: log in, get an L4 cookie; log out (or have the alpha server revoke), lose the cookie. Everything else (L1, L2, L3) is invisible to the user.
- The seam between L1 and L3 is the `?demo=cached` branch in `app/api/briefing/route.ts:78`. The same UI reads from either side depending on the query string.
- The seam between L1 and L2 is `cacheTtlMs` on `BloomreachDataSource.callTool`. Same `Map` shape, different lifetime semantics.

The mechanics in `02`-`08` each sit inside one of these layers.

## How it works

### Move 1 — the mental model

A real database does four jobs: store rows, index them, run queries, survive crashes. Pull those four jobs apart and look for who in this repo does each one — that's the picture you want to hold.

```
  The four jobs of a database — who does each here?

       store rows      →  Map (in lib/state/insights.ts)
       index rows      →  cache key string (in BloomreachDataSource)
       run queries     →  the Bloomreach server (via EQL strings)
       survive crashes →  the bi_auth cookie (for tokens only)

  three of the four jobs are absorbed by something else;
  the fourth (durability) is partial — only auth survives
```

That's the whole pattern. The rest of this file walks each layer.

### Move 2 — the four layers, one by one

#### L1 — In-memory Map (the table-analog)

The closest thing to a "table" in this repo is `sessionState` in `lib/state/insights.ts`. It's keyed by `sessionId` so each user gets their own sub-feed.

```typescript
// lib/state/insights.ts:8-23
type SessionFeed = {
  insights: Map<string, Insight>;            // ← the "insights" table
  investigations: Map<string, Investigation>; // ← the "investigations" table
  anomalies: Map<string, Anomaly>;           // ← the "anomalies" table
};

const state = new Map<string, SessionFeed>(); // ← partitioned by sessionId
```

Three "tables" inside a per-session container. The container is partitioned by `sessionId` — see `02-records-pages-and-storage-layout.md` for why that partition is load-bearing.

```
  L1 — the in-memory Map as a table

  state (outer Map)
    ├─ "sess-abc": { insights: Map, investigations: Map, anomalies: Map }
    ├─ "sess-def": { insights: Map, investigations: Map, anomalies: Map }
    └─ "sess-xyz": { insights: Map, investigations: Map, anomalies: Map }

  primary key: sessionId       (outer)
  primary key: insight.id      (inner)
  durability: until process restart
```

**What breaks if you remove the outer `Map`:** every session shares one feed → one user's `clear()` wipes another user's data mid-briefing. The comment at `lib/state/insights.ts:5-7` calls this out explicitly.

#### L2 — 60s response cache (the cache)

The cache (`BloomreachDataSource.cache`) is another `Map`, but its job is different: deduplicate calls to the upstream Bloomreach MCP server during a single briefing.

```typescript
// lib/data-source/bloomreach-data-source.ts:122
private cache = new Map<string, { result: unknown; expiresAt: number }>();
```

```
  L2 — response cache (the cache)

  cache (Map<string, Entry>)
    key:   "execute_analytics_eql:{eql:'...',time:'...'}"
    value: { result, expiresAt: now + 60000 }

  invalidation: TTL (60s default) OR process restart
  semantics:    write-through on skipCache; never cache errors
```

Two interesting rules here, both in the code:

- **Errors are never cached** (`lib/data-source/bloomreach-data-source.ts:179-181`) — a failed call must not poison the next attempt.
- **`skipCache` still write-throughs** (`:184-186`) — a forced refresh from `/debug` updates the cache so subsequent normal calls see the fresh value.

#### L3 — Filesystem JSON (the read replica / build artifact)

`lib/state/demo-insights.json` (665 lines) and `lib/state/demo-investigations.json` (3,487 lines) are committed snapshots. The capture route (`app/api/mcp/capture-demo/route.ts` — dev-only) runs a real briefing against Bloomreach and writes the result to those files. They then ship in the repo and serve as the `?demo=cached` data source.

```
  L3 — filesystem JSON (frozen read replica)

  capture (dev-only, manual) ──► writes lib/state/demo-*.json
                                          │
                                          │  git commit
                                          ▼
                                  ships in the build
                                          │
                                          │  app/api/briefing/route.ts:86
                                          ▼
                                  read-only on Vercel
                                          │
                                          ▼
                                  NDJSON streamed to UI
```

This is a read replica in the same sense that `git pull` is replication — point-in-time, manual, no lag because there's no streaming relationship. Detailed walk in `08-replication-and-read-consistency.md`.

#### L4 — Encrypted cookie (the durability story)

The `bi_auth` cookie is the only state that survives a Vercel cold start. It holds OAuth client information, tokens, PKCE verifier, and CSRF state — all under AES-256-GCM with `AUTH_SECRET` as the key.

```typescript
// lib/mcp/auth.ts:48-49
const AUTH_COOKIE = 'bi_auth';
const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 10; // 10 days
```

```
  L4 — bi_auth cookie (the only true durability)

  request in ──► withAuthCookies seeds ALS from cookie
                       │
                       │  (provider does many reads/writes)
                       ▼
                 ALS-scoped Store mutated in memory
                       │
                       │  (if dirty)
                       ▼
                 encrypt + Set-Cookie on response out
```

The full walkthrough lives in `07-wal-durability-and-recovery.md` — this is the closest thing the repo has to a write-ahead log, with an explicit dirty bit and a single flush per request.

### Move 3 — the principle

When you read a codebase expecting a database and find none, the move is not "find the database" — it's "find who's doing each of the four jobs a database does, and ask why that's enough." In this repo three of the four jobs are absorbed by something else (query planning lives in Bloomreach, indexing is replaced by a cache, row storage is per-process), and the fourth (durability) is honestly partial — only the auth cookie survives a crash. Recognizing that pattern is faster than hunting for a missing `prisma/`.

## Primary diagram

The full map, with the layers, the durability spectrum, and the only seam a user touches.

```
  The datastore map — four layers, one axis (durability)

  ┌─ Browser ──────────────────────────────────────────────────┐
  │  cookie: bi_auth (encrypted)              ◄── 10 days       │
  └──────────────────────────────┬─────────────────────────────┘
                                 │  every request
  ┌─ Vercel function ────────────▼─────────────────────────────┐
  │                                                             │
  │  ┌─ Process memory ───────────────────────────────────┐    │
  │  │  L1: sessionState Map  (insights/inv/anom per sid) │    │
  │  │  L2: cache Map         (60s TTL response cache)    │    │
  │  └────────────────────────────────────────────────────┘    │
  │         ▲                                                   │
  │         │ if ?demo=cached                                   │
  │         │                                                   │
  │  ┌─ Filesystem (RO) ──────────────────────────────────┐    │
  │  │  L3: lib/state/demo-*.json  (committed snapshot)   │    │
  │  └────────────────────────────────────────────────────┘    │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘

  durability spectrum:
    L2 < L1 < L3 < L4
    60s   restart  deploy   10 days
```

## Elaborate

The interesting historical note: the repo *did* once have a real database. PR #8 removed the Olist SQLite adapter — there was a `live-sql` mode in the factory, an `OlistDataSource` that read from a local SQLite file, and the comment in `lib/data-source/types.ts:8` still names it ("an Olist (SQL-backed) adapter previously lived behind this seam and was removed"). So the DataSource seam was designed to support real databases; the codebase just doesn't have one today.

The reason matters: the product's whole value is "talk to *your* Bloomreach workspace." Bloomreach owns the database. The MCP server owns the EQL planner. The model owns the reasoning. This app owns the orchestration and the UI — and orchestration state (the current briefing, the current investigation) is fine to lose on a restart because the user can always re-run it.

That's why the durability story is so thin: there's nothing valuable enough to persist except the OAuth tokens, and those got the one real piece of crypto work in the codebase.

## Interview defense

**Q: Where does the data live in this app?**

The answer is a map (mental, not data-structure) of four layers:

```
  L1  in-memory Map        per-process, per-session sub-maps
  L2  60s response cache   per-process, key-by-call-args
  L3  demo-*.json          read-only, committed
  L4  bi_auth cookie       encrypted, survives instance churn
```

The lead is: "there's no database. The four pieces of state are…" — then walk the picture above. The load-bearing detail is that the outer `Map` is keyed by sessionId so one user's `clear()` can't wipe another user's data.

**Q: How do you decide which layer something belongs in?**

Trace durability. If the thing must survive a Vercel cold start, it goes in the cookie (and gets crypto). If it must survive within one user's session but not across sessions, it goes in the L1 Map. If it's a repeat-call optimization with no correctness implications, it goes in the L2 cache. If it's frozen demo data, it goes in L3. The axis IS the decision rule.

**Q: What's the biggest risk in this design?**

The L1 Map has no recovery. If a Vercel instance recycles mid-briefing, the user sees their feed evaporate and has to re-run. That's by design (the briefing is cheap to redo and the alpha server's rate limits make persistence-then-recovery more complex than just re-running), but it's the load-bearing limitation of "no database."

## See also

- `02-records-pages-and-storage-layout.md` — how the session is laid out, why the partition is load-bearing
- `03-btree-hash-and-secondary-indexes.md` — the cache key as a hash index
- `07-wal-durability-and-recovery.md` — the bi_auth cookie as the one real durability story
- `08-replication-and-read-consistency.md` — the demo snapshot as a frozen read replica
- `09-database-systems-red-flags-audit.md` — ranked risks

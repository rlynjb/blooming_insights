# 03 — Indexing vs query patterns

**Access-shape efficiency · Case B (no DB) · the in-memory `Map` as the "index"**

## Zoom out — where this concept lives

In a database, indexes are the answer to "what queries do we run and what data structure makes them fast?" You look at your query patterns, add a B-tree here, a partial index there, a composite key on `(user_id, created_at)` where it hurts. Miss an index on a hot path and you get sequential scans that melt production.

Here, there's no B-tree. There's no SQL. What there is:

```
  Zoom out — where "indexing" happens without a DB

  ┌─ Service ─────────────────────────────────────────────────┐
  │  Map<sessionId, SessionFeed>                              │
  │    ├── insights:       Map<id, Insight>       ← O(1) key   │
  │    ├── anomalies:      Map<id, Anomaly>       ← O(1) key   │
  │    └── investigations: Map<insightId, Inv>    ← O(1) key   │
  │                                                            │
  │  ★ THIS FILE ★ — do the access patterns match the         │
  │  indexes (Map keys)? Where's the hot-path scan hidden?    │
  │                                                            │
  │  eval/receipts/ — 28 files, filename encodes the "index"   │
  │  eval/goldens/  — glob-loaded on startup                   │
  └────────────────────────────────────────────────────────────┘
```

The concept: **when you use a `Map`, the key IS the index.** The equivalent of "add an index on `insight_id`" is "use `Map<insightId, Investigation>` instead of `Investigation[]`." The equivalent of a *missing* index is looping through an array to find one item, or reading a whole directory to find one file.

## The structure pass — layers, one axis, seams

Hold one axis constant: **what's the access shape for this collection?**

```
  Axis: "how is this collection accessed?"

  ┌── collection ──────────────┬── access shape ─────────────┐
  │                            │                             │
  │ SessionFeed.insights       │ get by id     (hot: O(1))   │
  │                            │ list all      (feed render) │
  │                            │ replace all   (new brief)   │
  ├────────────────────────────┼─────────────────────────────┤
  │ SessionFeed.anomalies      │ get by id     (hot: O(1))   │
  │                            │ ↑ only during investigation │
  ├────────────────────────────┼─────────────────────────────┤
  │ SessionFeed.investigations │ get by insightId (O(1))     │
  │                            │ ↑ from the investigate page │
  ├────────────────────────────┼─────────────────────────────┤
  │ eval/receipts/*.json       │ read by runId (dir glob)    │
  │  → filename pattern         │ read by caseId (dir glob)   │
  │  = filesystem index        │ read latest (sort + pop)    │
  ├────────────────────────────┼─────────────────────────────┤
  │ eval/goldens/*.ts          │ read all (module import)    │
  │                            │ list all (index.ts glob)    │
  └────────────────────────────┴─────────────────────────────┘

  seam: the "index" moves from Map keys (in-memory)
        to filename patterns (on disk) at the eval boundary
```

The seam is important: **when the collection lives in memory, the index is a `Map` key; when it lives on disk, the index is a filename pattern.** Both are O(1) lookups if the query matches — and O(N) scans if it doesn't.

## How it works

### Move 1 — the mental model

You already know this from writing SQL: `WHERE user_id = ?` is fast when there's an index on `user_id`, slow when there isn't. Same shape here: `get(id)` is fast on a `Map<id, T>`, slow when you have to walk a `T[]` looking for the right one.

```
  The pattern — access shape matches (or doesn't match) the layout

    query                          layout                       cost
    ─────                          ──────                       ────

    getInsight(sessionId, id)      Map<id, Insight>             O(1)   ✓
    listInsights(sessionId)        [...map.values()]            O(N)   ✓ (feed rendering)
    getInvestigation(sess, id)     Map<insightId, Investigation> O(1)  ✓
    getCachedInvestigation(id)     mem.get → readJson(file)      O(1) mem, O(F) disk
                                    ↑ but disk read reparses
                                      the whole cache file

    receiptsForRunId(runId)        readdirSync + filter(endsWith) O(F) — F = files
                                                                  scan the whole dir
```

The good news: every server-side hot-path collection uses a `Map` keyed by the natural lookup key. The bad news: two access shapes are O(N) scans where they don't have to be — the dev-only investigation cache re-reads the whole JSON file every call, and the eval receipt loader scans the whole directory.

### Move 2 — the actual query shapes

Walk the collections one at a time. For each: what's the query, what's the layout, is it a match?

#### `SessionFeed.insights` — the primary feed

**Queries:**
  → `getInsight(sessionId, id)` — one-off lookup during investigation open.
  → `listInsights(sessionId)` — feed render, whole session.
  → `putInsights(sessionId, items)` — replace all (clear + set N).

**Layout:** `Map<string, Insight>` inside a per-session `SessionFeed` inside `Map<sessionId, SessionFeed>` (`lib/state/insights.ts:8-14`).

```
  Two-level Map — outer keyed by session, inner keyed by id

  Map<sessionId, SessionFeed>
    │
    │ get(sessionId) → O(1)
    ▼
  SessionFeed { insights: Map<id, Insight>, anomalies, investigations }
    │
    │ get(id) → O(1)
    ▼
  Insight

  end-to-end: O(1) for get, O(N) for list where N = insights in one session
```

Verdict: **access shape and layout match.** The two-level `Map` is doing the job a `(sessionId, insightId)` composite index would do in a DB.

The load-bearing decision: **why keyed by `sessionId` at all?** Because a single warm Vercel instance serves many users concurrently, and a module-level `Map<id, Insight>` would leak between sessions. The comment on `lib/state/insights.ts:6-8` names this directly: *"a single warm Vercel instance serves many users concurrently, so module-level Maps would bleed between sessions — and `putInsights`' clear() would wipe another user's feed mid-briefing."*

The DB analog is exactly the same: **you don't just index on `id`, you index on `(tenant_id, id)` — because "get row by id" without the tenant scope is a security bug, not just a slow query.**

#### `SessionFeed.anomalies` — the sidecar

**Queries:**
  → `getAnomaly(sessionId, id)` — only during investigation open (agent needs the raw shape).
  → cleared alongside insights in `putInsights`.

**Layout:** `Map<string, Anomaly>` keyed by the **insight's** id, not by any anomaly-native identifier.

That's a modeling choice: the anomaly *has no primary key* of its own. It borrows the insight's ID because they're always minted together. If you tried to store anomalies independently — say, from a different agent that doesn't produce insights — you couldn't; the anomalies map has no way to key them.

Verdict: **borrowed-key layout, fine for the current access shape, breaks the moment you need a second producer.**

#### `SessionFeed.investigations` — the deep-dive index

**Queries:**
  → `getInvestigation(sessionId, id)` — investigate-page render.
  → `putInvestigation(sessionId, inv)` — after the agent loop completes.

**Layout:** `Map<insightId, Investigation>` (`lib/state/insights.ts:86-92`) — natural foreign key from `Investigation.insightId` becomes the index key.

Verdict: **access shape and layout match.** `insightId` is the natural lookup key, and the `Map` provides O(1) access. No "add this index" would help.

#### `getCachedInvestigation` — the fallback chain (O(F) hidden scan)

**Query:** `getCachedInvestigation(insightId)` — one lookup per investigate-page open in dev/demo mode.

**Layout:** Three-source lookup (`lib/state/investigations.ts:22-28`):

```
  Cache chain — the hidden O(F) hop

  1. mem.get(insightId)               O(1)  in-memory Map
     ↓ miss
  2. readJson(CACHE_FILE)[insightId]  O(F)  re-parses .investigation-cache.json
     ↓ miss                                (F = size of the cache file)
  3. readJson(DEMO_FILE)[insightId]   O(F)  re-parses lib/state/demo-investigations.json
     ↓ miss                                (each call reparses from scratch!)
  4. null
```

The hidden cost: **`readJson` reads and JSON.parses the entire file every call.** For a small cache file this is fine. For a growing dev file (every dev-mode investigation appends) it will eventually hurt.

Verdict: **acceptable for dev/demo, would be a scan bug in prod.** The mitigation: dev mode isn't a hot path, and in production the file doesn't exist so tier 4 skips (line 24: `PERSIST ? readJson(CACHE_FILE)[insightId] : undefined`). Not something to fix now, something to *watch*.

Pseudocode of the fix if it becomes real:

```
  cache the parsed JSON in memory, re-read only on mtime change

  fileCache: Map<path, {mtimeMs: number, data: object}>

  readJson(path):
    stats = statSync(path)
    entry = fileCache.get(path)
    if entry and entry.mtimeMs == stats.mtimeMs:
      return entry.data                    // O(1) — reuse parsed
    data = JSON.parse(readFileSync(path))  // O(F) — only on change
    fileCache.set(path, {mtimeMs: stats.mtimeMs, data})
    return data
```

That converts the fallback from "O(F) every call" to "O(1) every call except after a write."

#### `eval/receipts/` — the filename pattern IS the index

**Queries:**
  → `receiptsForRunId(runId)` — used by `baseline.eval.ts:44-46` and `load.eval.ts`.
  → `receiptsForCaseId(caseId)` — implicit, when reviewing a case's history.
  → `pickLatestRunId()` — pick the newest run.

**Layout:** Files on disk, named `{caseId}-{runId}.json` (e.g. `01-conversion-drop-mobile-checkout-2026-07-03T04-08-28-644Z.json`).

The filename pattern IS the index. `baseline.eval.ts:44-46` implements it:

```typescript
const files = readdirSync(RECEIPTS_DIR)
  .filter((f) => f.endsWith(`${runId}.json`))
  .sort();
```

That's an O(F) scan across the whole receipts dir (F = 28 files today, grows by ~10 per baseline run). For a hackathon-scale receipts folder this is trivial. For 10,000 receipts it'd be a real cost.

```
  The filename-as-index — three query shapes, all O(F)

  eval/receipts/
    01-conversion-drop-mobile-checkout-2026-07-03T02-12-17-099Z.json
    01-conversion-drop-mobile-checkout-2026-07-03T02-47-24-392Z.json
    01-conversion-drop-mobile-checkout-2026-07-03T04-08-28-644Z.json  ← latest
    02-fraud-payment-failure-credit-card-2026-07-03T02-47-24-392Z.json
    02-fraud-payment-failure-credit-card-2026-07-03T04-08-28-644Z.json
    ...

  ── query: "all receipts for runId X" ───────────
     readdir + filter(endsWith(runId))     O(F)

  ── query: "all receipts for caseId Y" ──────────
     readdir + filter(startsWith(caseId))  O(F)

  ── query: "latest runId" ───────────────────────
     readdir + extract runIds + sort + pop O(F log F)
```

Verdict: **fine at hackathon scale, but the shape is already there for it to matter later.** The two natural "indexes" — by runId and by caseId — are both prefix/suffix substrings of the filename, which means any future move to a real query engine (e.g. SQLite over the receipt corpus) would trivially reconstruct them.

#### `eval/goldens/` — glob import at startup

**Queries:** always "give me all goldens" (both `it.each(goldens)` in run and lookups by index).

**Layout:** `index.ts` re-exports each `NN-*.ts` file as an entry in a hand-maintained array. Cost: paid once at module load, then O(1) for the array.

Verdict: **fine.** Access shape is "iterate all," and the array supports that in O(N).

### Move 3 — the principle

The principle: **`Map<key, T>` is your index; array iteration is your sequential scan.** For every collection, ask: "when I read from this, what's the lookup key I want?" If it's a natural identifier, use a `Map<identifier, T>`. If you don't know the identifier — you need to filter by predicate — that's an array `.filter()` and you should be honest about the O(N) cost.

The DB rule "add an index on the columns you filter/join by" translates directly: **choose the `Map` key by what your reads want, not what your writes produce.** The reason this repo's storage feels right is that it does exactly that — `insights` keyed by insight id (because the investigate page comes in with an id), `investigations` keyed by insightId (same reason), `Map<sessionId, ...>` at the outer level (because every request already knows its session).

## Primary diagram — the query/layout match matrix

```
  Every collection in this repo — is the layout right for the queries?

  ─────────────────────────────────────────────────────────────────────
  collection                    query                       layout   OK?
  ─────────────────────────────────────────────────────────────────────
  SessionFeed.insights          getInsight(id)              O(1)     ✓
                                listInsights()              O(N)     ✓
                                putInsights (clear + set N) O(N)     ✓

  SessionFeed.anomalies         getAnomaly(id)              O(1)     ✓

  SessionFeed.investigations    getInvestigation(id)        O(1)     ✓

  Map<sessionId, SessionFeed>   sessionState(sessionId)     O(1)     ✓
                                (isolate concurrent users)

  .investigation-cache.json     getCachedInvestigation(id)  O(F)     ⚠
    (via readJson)              ↑ re-parses whole file      dev-only,
                                  every call                acceptable

  eval/receipts/*.json          filter(endsWith(runId))     O(F)     ⚠
                                filter(startsWith(caseId))  O(F)     scale
                                sort + pop for latest       O(F log F) cliff
                                                                     at ~1000
                                                                     receipts

  eval/goldens/*.ts             iterate all                 O(N)     ✓
    (bundled at import)                                              (once)
  ─────────────────────────────────────────────────────────────────────

  Legend:
    ✓  layout matches access shape
    ⚠  scan cost latent; fine today, watch for growth
```

## Elaborate

Where the pattern comes from: this is the same *access-path selection* logic a DB query planner does — but done at code-write time instead of query-plan time. When you write SQL, the planner reads your `WHERE`/`JOIN` clauses and picks an index. When you write TypeScript against `Map`s, *you* are the planner: you commit to an access path when you declare the `Map`'s key type.

The consequence: **once the key is chosen, the access path is fixed.** Changing "I want to query anomalies by (metric, scope, timestamp) instead of by insightId" means restructuring the `Map` or adding a secondary `Map<compositeKey, id>` — the DB analog of adding a covering index.

The receipts-as-files pattern shows up widely — it's how CI systems store build artifacts, how Vercel stores deployment records, how `git` itself stores objects (a filename IS a hash IS an index). It scales further than you'd think, until it doesn't, and then you migrate to SQLite (github/actions did this) or an object store (Vercel).

Related reading: PoEAA's *Query Object* pattern — when the collection you're reading is large enough that filename patterns aren't enough, you introduce a Query Object that knows how to serialize predicates. Not needed here; worth naming as the escape hatch.

## Interview defense

### Q1 — "walk me through the indexes on your primary feed."

> There's no DB, so the "indexes" are the keys on the `Map` objects. My primary feed lives in `Map<sessionId, SessionFeed>` where `SessionFeed.insights` is `Map<insightId, Insight>`. That two-level `Map` is playing the role of a `(session_id, insight_id)` composite index — every get is O(1), and the outer level isolates concurrent users on a single warm serverless instance.
>
> The load-bearing decision: keying at the outer level by `sessionId` is what makes this safe under concurrency. Without it, a `Map<insightId, Insight>` at the module level would leak between users, and my `putInsights(items)` — which starts with `clear()` — would wipe another user's feed mid-briefing. Same rule as multi-tenant DB indexing: always scope by tenant.

```
  the two-level map = the composite index

  outer: Map<sessionId, ...>         ← "tenant" scope
   inner: Map<insightId, Insight>    ← "row" scope

  get(sessionId, insightId): O(1)
  put clears one tenant's rows at a time — never global
```

Anchor: "the outer `Map` key is my tenant discriminator; the inner is my row key."

### Q2 — "where's the missing-index equivalent in this codebase?"

> Two places, ranked. The hot path is fine — every server-side `Map` has the right key for its access shape. The scans are in the *cold* paths:
>
> 1. `getCachedInvestigation` re-parses `.investigation-cache.json` on every call (`lib/state/investigations.ts:15-20`). Dev-only, small file, not a bug today, but the shape means the cost grows linearly with cache size. Mitigation is a parsed-JSON memoization keyed on mtime.
>
> 2. `eval/baseline.eval.ts` scans the whole `eval/receipts/` directory to pick receipts for a runId (`readdirSync + filter`). O(F), fine at 28 files, would be a real cost at 10,000. Mitigation is subdirectories by runId, or an index file.
>
> Neither is a bug now. The point of noticing them is knowing *where* the DB migration would attack first when receipt storage outgrows the filename-pattern index.

Anchor: "the scans are all cold-path; the hot path is O(1) throughout."

### Q3 — "how would you handle a query like 'give me all insights with severity=critical across all sessions'?"

> That's the query the current layout can't answer efficiently. My `Map<sessionId, SessionFeed>` is keyed for per-session reads; a cross-session query means iterating every session and every insight — O(sessions × insights per session).
>
> The reason it doesn't matter today: I don't have that query. Every route in this app starts with "which session are you?" and stays scoped. If I *did* need it, I'd add a secondary index — a `Map<severity, Set<{sessionId, insightId}>>` — updated alongside the primary in `putInsights`. That's the DB analog of a partial index on `severity WHERE severity='critical'`.
>
> The tradeoff is honest: a secondary index has to be *maintained* on every write, and `putInsights`'s clear-and-rebuild pattern makes that easy — clear the secondary too, rebuild both together. Two `Map`s, one write path.

```
  the fix for a cross-session query, sketched

  primary:   Map<sessionId, SessionFeed>              ← unchanged
  secondary: Map<severity, Set<{sess, id}>>           ← new

  putInsights(sessionId, items):
    # clear old entries for this session from the secondary
    for i in currentInsights(sessionId): secondary.get(i.severity).delete({sess, i.id})
    # rebuild primary
    ...clear-and-set-both...
    # rebuild secondary
    for i in items: secondary.get(i.severity).add({sess, i.id})

  # then: bySeverity('critical') = O(count of critical insights) instead of O(all)
```

Anchor: "current layout is right for the current queries; a new query shape → new secondary `Map`, atomic write."

## See also

- `01-the-data-model-and-its-shape.md` — the ERD showing why `Map<insightId, Investigation>` was the natural key.
- `04-transactions-and-integrity.md` — `putInsights`'s clear-and-rebuild pattern as the enforcer of index consistency.
- `06-access-patterns-and-storage-choice.md` — where the access shape started to argue against a relational store.

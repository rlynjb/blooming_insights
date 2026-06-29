# Indexing vs query patterns

*Hash-keyed lookup (industry standard) · Project-specific*

## Zoom out, then zoom in

In a SQL database, the indexing question is: which queries run often, and what indexes do they need? An unindexed query that scans 10M rows is the classic data-modeling failure — the schema didn't account for the actual access pattern, and you find out under load.

This repo has no SQL and no query planner. But it has the same question, restated: **which lookups happen in the hot path, and what data structure makes them O(1)?** The answer is `Map`, and the keys are the indexes.

```
  Zoom out — where the "queries" live

  ┌─ UI layer ────────────────────────────────────────────┐
  │  /investigate/[id]  →  needs insight by id            │
  │  /investigate/[id]/recommend  →  needs Diagnosis      │
  └────────────────────────────┬──────────────────────────┘
                               │ HTTP w/ ?insightId=...
  ┌─ Service layer ────────────▼──────────────────────────┐
  │  /api/agent  resolveAnomaly(sid, insightId, ...)      │
  │     → getAnomaly(sid, id) → getInsight(sid, id)       │
  │  /api/briefing  listInsights(sid) at end of stream    │
  └────────────────────────────┬──────────────────────────┘
                               │ in-process Map lookup
  ┌─ Storage layer ────────────▼──────────────────────────┐
  │  ★ THE INDEXES ★                                       │
  │  Map<sessionId, SessionFeed>                          │ ← we are here
  │    SessionFeed.insights:        Map<id, Insight>      │
  │    SessionFeed.anomalies:       Map<id, Anomaly>      │
  │    SessionFeed.investigations:  Map<id, Investigation>│
  └───────────────────────────────────────────────────────┘
```

**Zoom in.** Every "query" in this codebase is a 1- or 2-level `Map.get()`. There are no list scans on the read path, no full-table sweeps, no joins. That sounds like a strength — and it is — but it's also the *reason* the data model can be this minimal. The access pattern was designed first; the storage shape followed.

## Structure pass

**Layers.** Three lookup altitudes in the system:

- **Session lookup** (outermost) — `state.get(sessionId)`. Keyed by the session cookie.
- **Entity lookup** (per session) — `feed.insights.get(insightId)` or `.anomalies.get(insightId)` or `.investigations.get(insightId)`.
- **Wire-replay lookup** (process-wide) — `mem.get(insightId)` in `lib/state/investigations.ts` — the cached `AgentEvent[]` for a finished investigation. Not session-scoped (more on why below).

**Axis traced — "how many comparisons to find this fact?"** The classic indexing axis. Hold it across the altitudes:

```
  Trace the comparison-count axis

  Session lookup          → 1 Map.get        → O(1)
  Entity lookup           → 1 Map.get        → O(1)
  Investigation cache     → 1 Map.get        → O(1) in-memory
                                              → O(N) JSON file scan
                                                (dev only — N tiny)

  listInsights(sid) for the feed
                          → 1 Map.get + .values() spread
                          → O(K) where K = insights this session
                            (always 5-10 in practice)
```

Everything is O(1) on the hot path. The one O(N) — the JSON file scan in `getCachedInvestigation` — is dev-only and N is 5 (the number of insights in the committed demo snapshot).

**Seams.** The seam that matters is **the dual-keyed insight↔anomaly store**:

```
  The seam: two maps, one key, two consumers

  ┌─ session feed ──────────────────────────────────────┐
  │                                                      │
  │  Map<insightId, Insight>   ←─── UI reads this        │
  │  Map<insightId, Anomaly>   ←─── agent loop reads     │
  │                                  this                │
  │  same key → two shapes for two consumers             │
  └──────────────────────────────────────────────────────┘
```

This is denormalization-as-an-index. The agent doesn't have to derive Anomaly from Insight on every investigation — the parallel `anomalies` map *is* the lookup index for "give me the original Anomaly for this Insight." See `02-normalization-and-duplication.md` for why both shapes exist; this file is about *why both shapes are indexed.*

## How it works

### Move 1 — the mental model

You know how a SQL primary key buys you O(1) lookup via a B-tree index? A `Map<id, Entity>` buys the same thing via a hash table — same Big-O, different mechanism. The "schema" here is "every entity has an id, every lookup is by id." Two consequences:

1. **There are no secondary queries.** No `WHERE severity = 'critical'`, no `ORDER BY timestamp DESC`. The agents produce a small ordered list; the UI takes that list in order. If you wanted "show me all critical insights across all sessions," there's no index for it — you'd have to scan every session.
2. **There are no joins.** The `Insight ←→ Diagnosis` and `Insight ←→ Recommendation[]` relationships are walked through the `Investigation` container (`{ insightId, reasoning, diagnosis, recommendations }`), which is itself stored by `insightId`. One lookup, all related entities.

```
  The pattern — Map as the only index

  query: "give me insight X and its diagnosis"

   sessionId ──► state.get(sid)        ── 1 hash lookup ──► SessionFeed
                       │
                       ▼
   insightId ──► feed.investigations.get(id)  ── 1 lookup ──► Investigation
                                                                  │
                                                                  ▼
                                                          { reasoning,
                                                            diagnosis,    ◄── here
                                                            recommendations }

  Two map lookups. Diagnosis comes free (lives inside Investigation).
```

The contrast with SQL: a relational version would be `insights JOIN diagnoses ON diagnoses.insight_id = insights.id` — one join, indexed on both sides. Same O(1) per row, but you'd pay query-plan overhead and a network round-trip. The `Map`-of-`Map`s skips both.

### Move 2 — the queries and their indexes

#### Query 1 — "show me the feed for this user"

The /api/briefing route at the end of a successful run emits every insight for the session. The "query":

```ts
// app/api/briefing/route.ts:286
for (const insight of listInsights(sid)) send({ type: 'insight', insight });
```

Backed by:

```ts
// lib/state/insights.ts:81-84
export function listInsights(sessionId: string): Insight[] {
  const s = state.get(sessionId);
  return s ? [...s.insights.values()] : [];
}
```

Two operations: one `Map.get(sessionId)` to find the session, then `.values()` to materialize the list. The list is 5-10 insights in practice — small enough that even a list scan would be fine, but the `Map`-as-the-feed gives you `.set`-by-id elsewhere for free.

**What the "index" is.** The insertion order of `Map.set()` *is* the feed order. JavaScript `Map` preserves insertion order — so the order the monitoring agent emits insights is the order the cards render. That's a load-bearing implicit contract.

```
  listInsights — the only list-shaped read

  Map<sessionId, SessionFeed>
       │
       │ 1 lookup
       ▼
  SessionFeed.insights: Map<id, Insight>
       │
       │ .values() — preserves insertion order
       ▼
  [Insight, Insight, Insight, Insight, Insight]   ← the feed
       │
       │ emit one at a time over NDJSON
       ▼
  React renders cards in this exact order
```

#### Query 2 — "give me the anomaly behind this insight" (the agent loop's read)

The investigate flow at `/api/agent` needs the *original* Anomaly to feed the diagnostic agent — not the enriched Insight. The lookup:

```ts
// app/api/agent/route.ts:35-60 (resolveAnomaly)
function resolveAnomaly(sessionId: string, insightId: string, insightParam?: string | null): Anomaly | null {
  if (insightParam) {
    try {
      const i = JSON.parse(insightParam) as Insight;
      if (i && typeof i.metric === 'string' && i.change && Array.isArray(i.scope) && i.severity) {
        return insightToAnomaly(i);                  // (a) client-provided, derived
      }
    } catch { /* fall through */ }
  }
  const a = getAnomaly(sessionId, insightId);        // (b) parallel map — preferred
  if (a) return a;
  const i = getInsight(sessionId, insightId);
  if (i) return insightToAnomaly(i);                 // (c) derive from Insight
  try {
    if (existsSync(DEMO_FILE)) {                     // (d) demo snapshot fallback
      const snap = JSON.parse(readFileSync(DEMO_FILE, 'utf8')) as { insights?: Insight[] };
      const di = (snap.insights ?? []).find((x) => x.id === insightId);
      if (di) return insightToAnomaly(di);
    }
  } catch { /* ignore */ }
  return null;
}
```

This is a **four-tier lookup ladder**, in priority order:

1. **Client-provided Insight** in `?insight=` param — survives Vercel's per-instance memory split (the route may hit a *different* warm instance than the briefing that produced the Insight).
2. **`getAnomaly(sid, id)`** — the parallel `Map<id, Anomaly>` on `SessionFeed`. The reason this map exists: the agent loop wants the raw shape, not the enriched one.
3. **`getInsight(sid, id)` + `insightToAnomaly`** — derive on the fly if (2) missed.
4. **Demo snapshot file scan** — `JSON.parse` the committed file, then `.find()` over its `insights[]`. O(N) over 5 items.

Notice the index choice. Tier 2 — the dedicated `Anomaly` map — is what makes (a) the agent loop fast and (b) the "give me the original anomaly" query not require deriving. That parallel map IS the index for "lookup Anomaly by insight id."

```
  resolveAnomaly — four tiers, preferred index first

  ┌─ 1. client-provided (?insight=JSON) ──┐  survives instance hop
  │     parse + validate                   │
  └────────────────┬───────────────────────┘
                   │ miss
  ┌─ 2. getAnomaly(sid, id) ──────────────▼┐  ← THE INDEX
  │     SessionFeed.anomalies.get(id)      │     direct Map lookup
  └────────────────┬───────────────────────┘
                   │ miss
  ┌─ 3. getInsight(sid, id) + derive ─────▼┐  fallback path
  │     same lookup, derive Anomaly        │
  └────────────────┬───────────────────────┘
                   │ miss
  ┌─ 4. demo snapshot scan ───────────────▼┐  cold path
  │     .find() over insights[]            │
  └────────────────────────────────────────┘
```

#### Query 3 — "give me the cached investigation for this insight"

The /api/agent route checks for a previously-saved investigation before running the agents:

```ts
// app/api/agent/route.ts:125-127
const cached = insightId && !live ? getCachedInvestigation(insightId) : null;
if (cached) {
  const events = step ? filterByStep(cached, step) : cached;
  // ... replay events with REPLAY_DELAY_MS pause between them
}
```

Backed by a three-tier lookup:

```ts
// lib/state/investigations.ts:22-28
export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
  if (mem.has(insightId)) return mem.get(insightId)!;                          // (a) in-memory
  const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;      // (b) dev file
  if (fromFile) return fromFile;
  const fromDemo = readJson(DEMO_FILE)[insightId];                             // (c) committed
  return fromDemo ?? null;
}
```

Two interesting choices. First, **the in-memory `mem` map is process-wide, not session-scoped**. That's deliberate — investigations are deterministic enough that one user running an investigation can answer another user's request for the same insight id. It's also why the dev file (`.investigation-cache.json`) is keyed by `insightId` alone, not `sessionId/insightId`. Second, **the demo file is the cold-fallback for production** — in prod, `PERSIST` is false, so the lookup is mem → demo, no file in between.

**What's not indexed.** There's no "list all cached investigations." The cache is purely point-lookup. If you ever needed an admin view "show me everything that's been investigated," you'd have to enumerate the `Map` and pay an O(N) walk.

```
  getCachedInvestigation — three tiers, in-memory first

  ┌─ a. mem (process-wide Map) ─────┐  hottest — warm instance
  └────────────────┬────────────────┘
                   │ miss
  ┌─ b. .investigation-cache.json ──▼┐  dev only (PERSIST=true)
  │    JSON.parse the whole file     │  O(file size) per call
  └────────────────┬────────────────┘
                   │ miss
  ┌─ c. demo-investigations.json ───▼┐  committed seed
  │    JSON.parse the whole file     │  same cost
  └─────────────────────────────────┘
```

#### Query 4 — `WorkspaceSchema` (the module-level singleton)

This isn't really a "query" — it's a cache lookup. The schema is bootstrapped once and held in module memory:

```ts
// lib/mcp/schema.ts:138,190-209
let cached: WorkspaceSchema | null = null;

export async function bootstrapSchema(
  dataSource: DataSource,
  opts: BootstrapOpts = {},
): Promise<WorkspaceSchema> {
  if (cached) return cached;
  // ... orchestrate 4 sequential MCP calls (~4-5s)
  cached = parseWorkspaceSchema({...});
  return cached;
}
```

**The lookup is O(1)** — it's a single variable check. But the cache **is process-wide**, not session-scoped — and not keyed by anything. That works because in practice there's one Bloomreach project per deployment (`BLOOMREACH_PROJECT_ID` env pin at line 180), so "the workspace schema" is a singleton. If you ever served two projects from one process, this cache would leak the first project's schema into the second's session.

The "index" is the variable name itself. The "key" is the implicit "the one project this process serves."

### Move 2 variant — the load-bearing skeleton

The lookup kernel has three parts. Strip any one and a real capability breaks:

1. **The `Map<sessionId, SessionFeed>` outer key.** Drop this and concurrent users on the same warm Vercel instance read each other's feeds. The test that pins this is `test/state/insights.test.ts:53-80` — two sessions writing concurrently must not overwrite or read each other's state. The outer Map *is* the multi-tenancy story. See `04-transactions-and-integrity.md` for the invariant in full.

2. **The id-keyed entity `Map`s.** Drop these (replace with arrays, `.find()`) and you go from O(1) to O(N) on every investigate-page navigation. With N small (5-10) it would still work — but the *type* of operation matters: `Map.get(id)` says "lookup by primary key" loud and clear, where `.find(x => x.id === id)` reads like a scan.

3. **The parallel `anomalies` map alongside `insights`.** Drop this and `resolveAnomaly` falls back to derive-from-Insight every time. That works (tier 3 of the ladder), but throws away the round-trip property: the diagnostic agent would get the *derived* anomaly (with `evidence: []`, no `impact`, no `history`) instead of the *original*. The agent would investigate without seeing the evidence that triggered the anomaly in the first place — which would change the quality of the diagnosis.

Hardening on top: the four-tier `resolveAnomaly` ladder is hardening; tiers 1 and 4 are recovery paths that exist because the warm-instance assumption (tier 2) can fail. The skeleton is just tier 2.

### Move 3 — the principle

When your data model is small enough that every "query" is a primary-key lookup, you don't need a database — you need a `Map` with the right keys. The trap is that the moment a real secondary query shows up ("all critical insights from last week"), the `Map`-only model collapses, because there's no index to scan. The signal to migrate isn't "we have a lot of data" — it's "we have a query whose answer isn't a single key lookup."

## Primary diagram

The full lookup map, with every "query" and the index it hits.

```
  Every lookup in the app, and the data structure that backs it

  ┌─ READS ──────────────────────────────────────────────────────────────┐
  │                                                                       │
  │  listInsights(sid)                                                    │
  │     state.get(sid)                                  → SessionFeed     │
  │     .insights.values()                              → Insight[]       │
  │     [O(1) lookup + O(K) materialize, K = 5-10]                        │
  │                                                                       │
  │  resolveAnomaly(sid, id)                                              │
  │     tier 1: parse(?insight= param)                  → Insight (raw)   │
  │     tier 2: getAnomaly(sid, id)                                       │
  │             state.get(sid).anomalies.get(id)        → Anomaly         │
  │     tier 3: getInsight(sid, id) + insightToAnomaly  → Anomaly         │
  │     tier 4: demo file scan + .find()                → Anomaly         │
  │     [O(1) tiers 1-3, O(N) tier 4, N = 5]                              │
  │                                                                       │
  │  getCachedInvestigation(id)                                           │
  │     tier a: mem.get(id)                             → AgentEvent[]    │
  │     tier b: read .investigation-cache.json[id]      → AgentEvent[]    │
  │     tier c: read demo-investigations.json[id]       → AgentEvent[]    │
  │     [O(1) tier a, O(file size) tiers b-c]                             │
  │                                                                       │
  │  bootstrapSchema(dataSource)                                          │
  │     cached || (4 MCP calls + parse)                 → WorkspaceSchema │
  │     [O(1) on cache hit; O(4 network) on cold start]                   │
  │                                                                       │
  └───────────────────────────────────────────────────────────────────────┘

  ┌─ WRITES ─────────────────────────────────────────────────────────────┐
  │                                                                       │
  │  putInsights(sid, items, anomalies)                                   │
  │     sessionState(sid).insights.clear()              ← THIS SESSION    │
  │     sessionState(sid).anomalies.clear()             ← only            │
  │     items.forEach(insights.set(id, i), anomalies.set(id, a))          │
  │                                                                       │
  │  putInvestigation(sid, inv)                                           │
  │     sessionState(sid).investigations.set(inv.insightId, inv)          │
  │                                                                       │
  │  saveInvestigation(insightId, events)                                 │
  │     mem.set(insightId, events)                                        │
  │     PERSIST ? writeFileSync(.investigation-cache.json, ...) : noop    │
  │                                                                       │
  └───────────────────────────────────────────────────────────────────────┘
```

## Elaborate

In a SQL world, the equivalent of every `Map<id, Entity>` here would be a `CREATE INDEX UNIQUE (id)` — the same O(1) point lookup. The mapping from "key in a Map" to "primary key in a table" is exact, and the cost shape is the same: O(1) on the hot path, no help on secondary queries. The repo is in the rare position where its query mix is *only* point lookups, so the simplest possible index does everything.

What the repo deliberately doesn't have: any kind of **N+1 query pattern**. The classic N+1 bug is "loop over a list, issue one query per item" — and the place it would show up here is the feed render. Today's feed reads `listInsights(sid)` once, gets the full list materialized, and emits cards. No per-card lookup, no per-card MCP call, no per-card storage hit. The investigation is loaded lazily — only when the user clicks into one. That's the right shape: bulk-load the index page, lazy-load the detail page.

A useful contrast: AdvntrCue (in your portfolio) uses Drizzle ORM + Postgres, so its "indexing question" is real — there are actual `CREATE INDEX` statements in migrations, and `EXPLAIN ANALYZE` is the diagnostic tool. Here, the diagnostic tool is "check that the lookup is `.get(id)` and not `.find(x => ...)`." Same question, very different surface.

## Interview defense

**Q: What are the indexes in this codebase?**

> Every `Map` keyed by id is an index. The outer one is `Map<sessionId, SessionFeed>` — multi-tenancy index. Inside each session, three parallel `Map`s keyed by `insightId`: `insights`, `anomalies`, `investigations`. Plus a process-wide `Map<insightId, AgentEvent[]>` for the investigation replay cache. All O(1) on the hot path. The only O(N) is a `.find()` over the demo snapshot's `insights[]`, used as the last-resort fallback when the warm instance has no memory for the requested id.

```
   the indexes

   Map<sessionId, SessionFeed>           ← multi-tenancy
     SessionFeed
       .insights:        Map<id, _>       ← entity index
       .anomalies:       Map<id, _>       ← parallel index (round-trip)
       .investigations:  Map<id, _>       ← entity index

   Map<insightId, AgentEvent[]>          ← investigation cache
   let cached: WorkspaceSchema | null    ← singleton cache
```

**Q: Why is there a parallel `anomalies` map alongside `insights` if you could derive Anomaly from Insight?**

> The round trip drops fields by design — `insightToAnomaly` resets `evidence: []` and drops `impact`, `history`, `category`. Tested explicitly in `test/state/insights.test.ts:112-130`. If the agent loop derived Anomaly from Insight every time, the diagnostic agent would investigate without ever seeing the original evidence that triggered the anomaly. The parallel map is the index that preserves the un-dropped original.

**Q: What query would break this model?**

> Anything that isn't a point lookup. The clearest example: "show me all critical insights for this user from the last 7 days, sorted by severity." That's a `WHERE severity = ? AND timestamp > ?` + `ORDER BY severity`, with no supporting index. Today the feed only ever shows the *current* briefing — so the only "filter" is "this session, right now" — and the only "sort" is "the order the agent emitted them." The day product asks for history is the day the `Map` model has to grow up. The smallest move would be adding a secondary `Map<severity, Set<insightId>>` per session; the right move would be moving to a real store.

```
   what breaks the Map-only model

   today's query:    "feed for this session"   → listInsights(sid)   ✓
   imaginary query:  "critical insights since   → no index           ✗
                      Monday, sorted by severity"
```

## See also

- `01-the-data-model-and-its-shape.md` — the entity shapes the `Map`s store.
- `04-transactions-and-integrity.md` — why session isolation is the only invariant the `Map` model has to defend.
- `06-access-patterns-and-storage-choice.md` — when point-lookup-only stops being enough.

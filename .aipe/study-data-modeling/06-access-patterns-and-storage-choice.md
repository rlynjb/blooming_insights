# Access patterns and storage choice

*Storage-shape-to-access-pattern fit (industry standard) · Project-specific*

## Zoom out, then zoom in

The matching question every storage choice answers: **does the shape of the store match the shape of the queries?** Get this right and the storage almost disappears — every operation is one move. Get it wrong and the codebase is full of friction: joins to reassemble what should be one document, scans to find what should be one index, hand-rolled "would be a transaction in Postgres" logic.

This repo deliberately doesn't use a database. The store is `Map`s + a couple of committed JSON files. Whether that's the right call depends entirely on the access pattern — so this file walks the access pattern first, then names why the storage shape is (or isn't) the right fit.

```
  Zoom out — what "storage" means here

  ┌─ UI layer ──────────────────────────────────────────┐
  │  reads:  full Insight (1-shot, no joins)            │
  │  reads:  full Investigation (1 id → 1 tree)         │
  │  writes: none — UI is read-only over the agent loop │
  └────────────────────────┬───────────────────────────┘
                           │
  ┌─ Service layer ────────▼───────────────────────────┐
  │  writes: full feed at end of briefing (clear+rewrite) │
  │  writes: full investigation at end of agent run      │
  │  no incremental updates, no partial writes           │
  └────────────────────────┬───────────────────────────┘
                           │
  ┌─ Storage layer ────────▼───────────────────────────┐
  │  ★ THE STORE ★                                       │
  │  Map<sessionId, SessionFeed> — RAM, ephemeral        │ ← we are here
  │  + 4 JSON files — disk, ephemeral or committed       │
  │  (no SQL, no KV, no document DB)                     │
  └─────────────────────────────────────────────────────┘
```

**Zoom in.** The access pattern is: **write a complete entity once at the end of an agent run; read it by primary key when the user navigates to it; drop everything when the warm instance dies.** That's a perfect document-shape access pattern with a session-scoped lifecycle and no concurrent writers. The `Map`-and-JSON store matches it. The day the pattern grows a "save this," "annotate this," or "find similar across all sessions," the fit breaks — and *that's* when storage choice changes. This file is about *why the fit holds today* and *what would break it*.

## Structure pass

**Layers.** Three altitudes of access:

- **Within a request** — the agent loop reads `WorkspaceSchema`, writes `Insight[]` and `AgentEvent[]`. All synchronous, all in-process.
- **Across requests, same session** — the feed page reads what the briefing wrote; the investigation page reads what the agent run wrote.
- **Across instances / cold-start** — Vercel's warm-instance lifecycle means *no* in-memory state survives. Only the committed demo snapshot and (in dev) the file caches do.

**Axis traced — "how does this fact survive between two reads?"** Hold that question through the layers:

```
  Trace the survival axis through the access tiers

  same request:
    in-memory Map → survives (one process, one stack)

  same session, same instance:
    in-memory Map → survives (warm instance hasn't recycled)

  same session, instance hop (Vercel):
    in-memory Map → LOST  (different ephemeral process)
    cookie:        survives (browser)
    snapshot file: survives (read-only, deployed code)

  cross-session:
    nothing survives — by design (session isolation)
    + demo snapshot survives (it's "everyone's seed")

  cold start (instance died, request hits new one):
    in-memory Map → LOST (gone with the process)
    cookie:        survives
    snapshot file: survives
```

**Seams.** Three places the storage shape touches the access shape:

1. **The feed write at end-of-briefing** — `putInsights(sid, items)` writes the *entire* feed atomically (synchronously) by clearing and rewriting. Matches the access pattern (briefing IS the feed, no incremental).
2. **The investigation cache as cross-session memo** — `mem.set(insightId, events)` is *not* session-scoped. Same insightId from a different session reads the same cached events. Matches the implicit assumption that investigation results are deterministic enough to share.
3. **The demo snapshot as cold-start fallback** — `lib/state/demo-insights.json` is the safety net for "warm instance has nothing." Matches a presentation-reliability axis (the demo button always works, even cold).

## How it works

### Move 1 — the mental model

You know how a frontend's localStorage works — set the key, read it by name, no joins, no queries, gone when the user clears their data? The runtime store in this repo is the same shape: `Map.set(id, value)` / `Map.get(id)`, ephemeral, single-process. The only difference is the lifecycle: warm-instance memory dies on cold start, where localStorage survives until the user clears it.

The choice tree this repo walked:

```
  The storage decision tree — what got picked and what got skipped

  Do you have persistent server-side data?
       │
       ├── NO  → in-memory Map + JSON snapshot      ← THIS REPO
       │
       └── YES → Is the access pattern document-shaped?
                      │
                      ├── YES → document store (Mongo, DynamoDB)
                      │         or Postgres jsonb columns
                      │
                      └── NO  → Is it relational (multi-entity joins)?
                                     │
                                     ├── YES → Postgres / MySQL
                                     │
                                     └── NO  → KV (Redis, DynamoDB)
```

The first fork is the load-bearing one. This repo answered NO because (a) the agents produce the data fresh on every briefing, (b) there's no user-created data to preserve, and (c) the only "long-lived" artifact is the demo snapshot (which is presentational, not transactional). Postgres would buy nothing here — and would cost a connection-per-instance, a deploy story, and a migration framework.

### Move 2 — the access pattern, named

#### Pattern 1 — bulk-write at end-of-agent-run, point-read by id

The shape every "write" follows:

```
  The write pattern — bulk, end-of-run, no incremental

  agent run starts
       │
       │  agent does work (5-30 seconds for monitoring,
       │  90-115s for full investigation)
       │
       │  emits events over NDJSON as it goes (UI stream)
       │  collects events in a `collected: AgentEvent[]`
       ▼
  agent run ends
       │
       │  putInsights(sid, allInsights)  ← clear + bulk write
       │  saveInvestigation(id, events)  ← bulk write
       ▼
  done
```

The streaming output to the UI is *not* the write. The writes happen at the end, when the agent has produced its complete output. Everything in the store is "the latest complete run for this id." There's no append, no patch, no incremental update.

The shape every "read" follows:

```
  The read pattern — single point lookup by primary key

  UI navigates to /investigate/[id]
       │
       │  resolveAnomaly(sid, id) — 1 Map.get
       │  getCachedInvestigation(id) — 1 Map.get
       ▼
  full Investigation hydrates the page
       │
       │  no further reads — the page renders from this one tree
       ▼
  user reads it
```

One id in, one entity tree out. No `WHERE`, no `JOIN`, no `ORDER BY`. The `Map<id, Entity>` store is *exactly* shaped for this access pattern — every other shape would be friction.

#### Pattern 2 — the WorkspaceSchema as singleton cache

The MCP bootstrap is expensive (4 sequential calls, ~4-5s end-to-end under the ~1 req/s server limit). The pattern is:

```
  WorkspaceSchema — read-mostly, write-once-per-process

  process start
       │
       │  cached = null
       ▼
  first request hits bootstrapSchema()
       │
       │  list_cloud_organizations  (1 req)
       │  list_projects            (1 req, depends on orgs)
       │  get_event_schema         (1 req, depends on project)
       │  get_customer_property_schema (1 req)
       │  list_catalogs            (1 req)
       │  get_project_overview     (1 req)
       │  → ~5 seconds total
       ▼
  cached = parseWorkspaceSchema(...)
       │
       │  subsequent requests on same process:
       │  if (cached) return cached  → 0ms
       ▼
  process dies eventually, cycle repeats
```

The storage choice here is `let cached: WorkspaceSchema | null = null` — a module-level variable, no key, no map. That's a *singleton cache*, justified by the access pattern: one project per deployment (`BLOOMREACH_PROJECT_ID` is env-pinned, line 180), so there's only ever one valid schema. The day you serve two projects from one process, this singleton becomes a cross-tenant bug.

#### Pattern 3 — the investigation cache as cross-session memo

Investigations are cached by `insightId` only, NOT by `sessionId`:

```ts
// lib/state/investigations.ts:11
const mem = new Map<string, AgentEvent[]>();
```

Compare to the insights store:

```ts
// lib/state/insights.ts:14
const state = new Map<string, SessionFeed>();  // outer keyed by sessionId
```

**Why the asymmetry.** Insights are session-scoped because they're a current view of "what I'm investigating right now." Two users running parallel briefings have to see independent results. Investigations are insight-scoped because the diagnosis of insight X is deterministic-ish — once the agents have run it, the result is reusable.

That sharing across sessions is the whole reason the cache is one map, not nested. The trade: a user can read the cached investigation that *another user's* agent produced — fine for this product (the data is anonymous Bloomreach analytics, no PII in the insight body), problematic the day insights carry user-specific context.

```
  Asymmetric scoping — why insights are session-keyed but investigations aren't

  Map<sessionId, SessionFeed>  ← insights        (the "my current feed" view)
     SessionFeed.insights       per-session
     SessionFeed.anomalies      per-session
     SessionFeed.investigations per-session  (legacy — duplicates `mem`)

  Map<insightId, AgentEvent[]>  ← investigations (the "this id's result" memo)
     process-wide, cross-session
     deterministic results → safe to share
```

#### Pattern 4 — the demo snapshot as cold-start floor

The demo path (`?demo=cached`) reads `lib/state/demo-insights.json` directly — no MCP, no agents, no Anthropic call. The access pattern:

```
  Demo path — bypass live tier, read straight from disk

  /api/briefing?demo=cached
       │
       │  existsSync(DEMO_FILE)?
       ▼
  JSON.parse(readFileSync(DEMO_FILE))
       │
       │  replay as NDJSON stream with REPLAY_DELAY_MS pause
       │  (so it feels live, even though it's static)
       ▼
  feed renders, user navigates to an investigation
       │
       ▼
  /api/agent?insightId=...  (no &live=1)
       │
       │  getCachedInvestigation(id) — tier (c): demo file
       ▼
  Investigation replays the same way
```

This is **storage-as-source-of-truth for the demo path**. The committed JSON IS the canonical answer for `?demo=cached`. No agent runs, no MCP calls. That's why the snapshot has to stay valid across schema evolutions (covered in `05`) — it's not test data, it's production data for the demo lane.

### Move 2 variant — relational vs document vs KV (the seam to system-design)

The repo's storage is best described as **session-scoped document store** — every entity is read as a complete document, the only "query language" is `Map.get(id)`. A relational version would shred the same data into tables:

```
  Hypothetical relational rebuild — what changes

  ┌─ document shape (today) ─────────┐
  │  Insight {                       │
  │    id, timestamp, severity,      │
  │    metric, scope[], change{...}, │
  │    evidence: [{tool, result},...]│
  │    revenueImpact: {...},         │
  │    funnel: {...},                │
  │  }                                │
  │  → 1 Map.get(id) returns all     │
  └───────────────────────────────────┘

                vs.

  ┌─ relational shape (hypothetical) ────────────────────┐
  │  insights        (id, timestamp, severity, metric)   │
  │  insight_scope   (insight_id, scope, ordinal)        │
  │  insight_change  (insight_id, value, direction, ...) │
  │  evidence        (insight_id, tool, result_json)     │
  │  revenue_impact  (insight_id, lost_usd, expected)    │
  │  funnel          (insight_id, view, cart, ...)       │
  │  → reading 1 insight = 6 SELECTs + assembly          │
  │     OR 5 JOINs                                       │
  └──────────────────────────────────────────────────────┘
```

Two things wrong with the relational version: (a) you never want any subset of these fields — the card always renders the whole thing — so the shred is pure overhead; (b) `evidence.result` is `unknown` (the LLM's tool output, arbitrary shape) and would have to land in a `jsonb` column anyway. Postgres-with-jsonb-everywhere is functionally the same as a document store, just with more setup.

A KV version (Redis, DynamoDB) would be the right *cloud* analog to the `Map` model — write the whole document under a key, read by key, no queries. The day you outgrow in-memory (multi-instance read-after-write for the same session, or persistent investigation cache), KV is the natural next step. Postgres is not.

### Move 2.5 — current state vs future state

```
  Phase A — today                  Phase B — if user data lands
  ───────────────                  ─────────────────────────────

  Storage:                         Storage:
   • Map per session                • Postgres (or DynamoDB) for
   • JSON snapshot                    user-owned rows
                                    • Map per session STILL for
                                      the agent's working state

  Survival:                        Survival:
   • dies with the warm instance    • persists across instances
   • demo snapshot survives          • per-user data survives

  Concurrency:                     Concurrency:
   • one writer per session         • multi-instance writers
   • synchronous, no transactions    • requires real transactions
                                       on the new tier

  Migrations:                      Migrations:
   • optional-field discipline      • migration framework + the
   • recapture demo on breaks         optional-field discipline
                                       (both, not either)

  Cost of the change:
   → adding user data costs you the entire Phase B column, all at once.
     This is why "don't add a database until you have to" is the right
     call: today's storage is appropriate because today's data has no
     users. Tomorrow's storage will be different because tomorrow's
     data will.
```

### Move 3 — the principle

Storage choice is the answer to *"what's the long-lived data and who owns it?"* — not to *"what database is cool right now."* When the long-lived data is the LLM's output (re-derivable on demand) and a demo snapshot (recapturable on demand), the answer is "a `Map` and a JSON file." When the long-lived data is something the user typed and would lose if you blew it away, the answer changes — and the optional-field discipline, the synchronous-write convention, the singleton schema cache all need a new home that can survive a deploy. The repo is *correctly* simple today because the data has no owner outside the system. The signal to migrate is the first feature that adds one.

## Primary diagram

The full storage map — every tier, every survival boundary, every access path.

```
  Every tier of the storage, every fact, every survival rule

  ┌─ TIER 1: process memory (warm Vercel instance) ─────────────────────┐
  │                                                                      │
  │  Map<sessionId, SessionFeed>             insights/anomalies/         │
  │                                          investigations              │
  │  Map<insightId, AgentEvent[]>            investigation replay cache  │
  │  let cached: WorkspaceSchema | null      project context cache       │
  │                                                                      │
  │  SURVIVES: same request, same warm-instance lifetime                 │
  │  DIES:     cold start, instance recycle, deploy                      │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘

  ┌─ TIER 2: dev-only disk caches (gitignored) ─────────────────────────┐
  │                                                                      │
  │  .auth-cache.json                        OAuth tokens, PKCE state    │
  │  .investigation-cache.json               cached investigation events │
  │                                                                      │
  │  SURVIVES: dev server hot-reload (which wipes module memory)         │
  │  DIES:     `rm` or NODE_ENV ≠ development                            │
  │  PROD:     not used (Vercel filesystem is read-only)                 │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘

  ┌─ TIER 3: committed JSON (deployed with the code) ───────────────────┐
  │                                                                      │
  │  lib/state/demo-insights.json            full demo feed snapshot     │
  │  lib/state/demo-investigations.json      full demo investigations    │
  │                                                                      │
  │  SURVIVES: forever (until next commit / capture)                     │
  │  WRITTEN:  dev-only via /api/mcp/capture-demo                        │
  │  READ:     ?demo=cached path + cold-start fallback (tier c)          │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘

  ┌─ TIER 4: encrypted browser cookie ──────────────────────────────────┐
  │                                                                      │
  │  bi_session         (uuid)               session identity            │
  │  bi_auth            (AES-256-GCM)        OAuth tokens, prod only     │
  │                                                                      │
  │  SURVIVES: 10 days OR until user clears cookies                      │
  │  WRITTEN:  /api/mcp/connect + /api/mcp/callback                      │
  │  READ:     every API route                                           │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘

  ┌─ ACCESS PATTERNS ────────────────────────────────────────────────────┐
  │                                                                      │
  │  feed render:                                                        │
  │    1 Map lookup (sessionId) → SessionFeed                            │
  │    .insights.values() → array                                        │
  │                                                                      │
  │  investigate render:                                                 │
  │    1 Map lookup (insightId) → AgentEvent[]                           │
  │    OR 4-tier fallback (resolveAnomaly)                               │
  │                                                                      │
  │  bootstrap schema:                                                   │
  │    cached || (4 sequential MCP calls)                                │
  │                                                                      │
  │  demo path:                                                          │
  │    readFileSync(demo-*.json) + JSON.parse                            │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The closest portfolio analog is **dryrun's GitHub-as-backend**: no SQL server, content stored as files in a Git repo, reads are file fetches, writes are commits. The motive is the same — the data has no real "users" beyond the author, the access pattern is "load the whole document," and the persistence story is the deploy itself. The differences are scale (GitHub is durable forever, the Vercel warm instance is not) and the write path (Git commits vs JSON.stringify + writeFile), but the modeling decision is the same shape: skip the database because the data lifecycle doesn't need one.

The contrast with AdvntrCue (your RAG project): there, the data has structure (chunks, embeddings, sessions, messages) and the access pattern includes *vector similarity search*, which needs an index that a `Map` can't provide. Postgres + pgvector is the right call because (a) there's user-typed data (sessions, messages) that must survive, (b) the query is non-trivial (top-K nearest neighbors), and (c) the schema is relatively stable. Same engineer, opposite call — and the deciding factor was the access pattern, not "what's a good DB."

What this repo trades away by skipping a database: **cross-session admin views** ("show me every critical insight surfaced this week"), **user-owned saved state** ("dismiss this insight," "annotate this recommendation"), **persistent investigation history** (today, the investigation cache dies with the warm instance unless captured to the snapshot). Each of those is a real product feature, and each would force a storage rethink. The repo correctly hasn't shipped any of them — and so the storage stays minimal.

## Interview defense

**Q: Why no database?**

> Three reasons. First, the access pattern is document-shaped — every read is "give me the full Insight by id," every write is "store the whole agent output at end of run." A `Map<id, Entity>` matches that exactly; Postgres would shred each entity into 6 tables and pay 5 joins to assemble one card. Second, the data lifecycle is briefing-scoped — re-running the agents produces fresh anomalies; the only long-lived artifact is the demo snapshot, which is presentational. Third, serverless: no long-lived process means an ORM is fighting the runtime. The day the product adds user-typed data — annotations, dismissals, saved investigations — the storage rethinks, but today there's no user data to preserve.

```
   why no DB today

   document-shaped access  → Map<id, _> is the right index
   briefing-scoped data    → no long-lived data to outlive the process
   serverless runtime      → no ORM connection to amortize
```

**Q: What's the load-bearing detail people miss?**

> The investigation cache is *not* session-scoped. The insights map is `Map<sessionId, SessionFeed>`, but the investigation memo is `Map<insightId, AgentEvent[]>` — flat, process-wide. That asymmetry is deliberate: investigations are deterministic enough to share, so one user's investigation result is cached for any other user that asks about the same insight id. It works because the insight bodies are anonymous Bloomreach analytics, no PII. It would break the day insights carried user context — and you'd want to re-key by `(sessionId, insightId)`.

```
   the asymmetric scoping

   insights:        Map<sessionId, ...>   per-user (privacy + concurrency)
   investigations:  Map<insightId, ...>   process-wide (deterministic results)
```

**Q: What's the migration path if you grow into needing a database?**

> KV first, not relational. The right next step is something like DynamoDB or Redis with `(sessionId, insightId)` as the composite key — same document shape, cross-instance persistence, no schema rework. Postgres would only be right if a new feature added a query that *isn't* a point lookup ("show all critical insights from the last 7 days") and that query needs an index that's not a primary key. Today no such query exists. The signal to move to Postgres would be the first product ask for cross-session filtering or sorting.

```
   the migration ladder

   Map (today)         in-memory, process-scoped
       │
       ▼
   KV (tomorrow?)      cross-instance, point lookup only
       │
       ▼
   Postgres (later?)   needed only when secondary queries arrive
```

## See also

- `01-the-data-model-and-its-shape.md` — the document shape the storage is built around.
- `03-indexing-vs-query-patterns.md` — why point-lookup-only is all the indexing the model needs today.
- `05-migrations-and-evolution.md` — the optional-field discipline that makes the JSON snapshot safe as long-lived data.

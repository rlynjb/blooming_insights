# Access patterns and storage choice

**Industry term:** Access-pattern-driven store selection · document vs relational vs KV · **Type:** Industry-standard concept, applied here to a repo whose deliberate choice is *no persistent store at all* (except JSON files and in-memory Maps).

## Zoom out, then zoom in

**Zoom out — where the storage-choice question lands.** In an app that reaches for Postgres, you're picking between relational vs document vs KV vs event log. blooming_insights doesn't reach for any of those — the storage layer is a `Map`, a set of JSON files, and (indirectly, through Bloomreach MCP) the analyst's event stream. The interesting question isn't "which database?" — it's "does *no database* actually match the access pattern?"

```
  Storage-choice question — where each read/write lands

  ┌─ Request path (hot) ────────────────────────────────────────┐
  │  writes: 1 briefing per session       (few Insights)         │
  │  reads:  1 feed load + 1 card open   (get by id)             │
  │  → access pattern: write-once, read-many-within-session      │
  │  → store: in-memory Map<sid, {Map, Map, Map}>                │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ Demo path (warm) ──────▼───────────────────────────────────┐
  │  writes: rare (dev-only capture)                             │
  │  reads:  on every demo mode render                           │
  │  → access pattern: read-mostly, single-file snapshot          │
  │  → store: committed JSON file (lib/state/demo-*.json)        │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ Eval path (cold, batch) ▼──────────────────────────────────┐
  │  writes: 1 receipt per (case, run) = N per run               │
  │  reads:  aggregate ALL receipts of a run per invocation      │
  │  → access pattern: append-only log with occasional roll-up  │
  │  → store: file-per-record directory (eval/receipts/)        │
  └─────────────────────────────────────────────────────────────┘
```

**Zoom in — the pattern.** Three access patterns, three stores, and — importantly — three matches. This concept sits at the seam between data modeling (this guide) and system design (`study-system-design/`): choosing *which* store is architecture; matching the store *shape* to the access pattern is data modeling. This file covers the second half.

## Structure pass

### Layers of storage choice

```
  Store selection — the tree

     "how often do I write?"
        ├── once per request → in-memory (RAM is the store)
        │       ├── read-by-id only        → Map<id, T>
        │       └── partition by session   → Map<sid, Map<id, T>>  ← this
        │
     "how often do I read?"
        ├── continuously (demo)  → single-file snapshot
        │       └── committed → JSON blob, versioned in git
        │
     "how many records will accumulate?"
        ├── few, immutable       → one file per record          ← eval receipts
        │       └── query pattern? → scan all + parse (see file 03)
        │
        ├── many, mutable        → real database
        │       └── not exercised in blooming_insights today
        │
        └── many, immutable log  → append-only file / event store
                └── not exercised today (would be the next step
                    if receipt volume grew)
```

### One axis: **does the store shape match the access shape?**

Match check per path:

- **Request path:** access is `(sid, id)` → `Insight`; store is `Map<sid, Map<id, Insight>>`. **Match.** Every read is O(1).
- **Demo path:** access is "the whole snapshot at once"; store is one file. **Match.** One `readFile + parse` per load.
- **Eval path:** access is *sometimes* `(runId, caseId)` → one receipt (match — filename encodes both), but *usually* "aggregate all receipts of a run" (mismatch — filename filter + N parses). **Partial match.**

### Seams — where store shape flips

- **The RAM-to-disk seam.** In-memory `Map` for request state; JSON files for anything that must survive a process. Above the seam: fast, ephemeral. Below: slower, durable. There's nothing in the middle — no SQLite, no Redis. That's the deliberate design.
- **The single-file-vs-file-per-record seam.** Demo state is one file; eval receipts are N files. Above: whole-snapshot access; below: individual-record access with occasional roll-up. The moment aggregation becomes frequent, the file-per-record shape starts to hurt.

## How it works

### Move 1 — the mental model

The right way to think about storage choice: **the shape of your query is a demand, the shape of your store is a supply. Match them or you pay the mismatch tax on every read.** A Postgres row is great for point lookups by primary key and terrible for "give me the last N events in order" (unless you add an index that makes it good). A Kafka log is great for "give me events from offset X" and terrible for "find the event where user_id = 42" (unless you add a projection that makes it good).

```
  Access-pattern-to-store matching — the demand and supply

     access-shape (demand)                      store-shape (supply)
     ────────────────────                       ────────────────────
     "point lookup by known id"     ────►       Map / KV / indexed table
     "the whole thing right now"    ────►       single file / snapshot
     "range in insertion order"     ────►       array / log / sequence
     "match on a field's value"     ────►       secondary index / query
     "join across records"          ────►       relational + FKs
     "aggregate by group"           ────►       roll-up table / mat view

     mismatch tax:
       scan when you should have looked up
       parse when you should have queried
       join in app code when you should have joined in the store
```

For blooming_insights, each of the three paths has a demand and a supply — the question is whether they line up.

### Move 2 — the three paths, walked

#### Path A — the request path (perfect match)

**Access pattern:** During a briefing, the monitoring agent produces a handful of `Insight`s. The route handler puts them into state under the session id. The UI then reads them: first as a list (the feed page), then by id (the investigate page). Reads outnumber writes by ~5x per session.

**Store:** `Map<sessionId, { insights: Map<id, Insight>, ... }>` at `lib/state/insights.ts:14`.

Walk the match:

- Write shape: `putInsights(sid, items)` at line 57 — one function call, N inserts (typically 3-8). O(N).
- Read-by-id shape: `getInsight(sid, id)` at line 73 — two Map hits. O(1).
- Read-list shape: `listInsights(sid)` at line 81 — one session hit + O(k) values spread.

Every access primitive the app uses has an O(1) or O(k) implementation in the Map-of-Maps. **The store shape is the access shape.**

```
  Request-path match — access primitives ↔ store operations

     UI wants                          Map<sid, {Map}> gives
     ─────────                         ─────────────────────
     "the feed for this session"   →   state.get(sid).insights.values()
     "one card by id"              →   state.get(sid).insights.get(id)
     "put the fresh briefing"      →   .clear() then .set() × N
     "delete stale sessions"       →   NOT DONE — sessions accumulate
                                       until process restarts
```

The last item is the visible cost: **there's no eviction.** Long-lived processes accumulate session Maps forever. Vercel functions cycle every few hours so this is capped in practice, but on a truly long-running server, this would leak. → cross-link to `study-system-design/` for the cold-start / warm-instance implications.

#### Path B — the demo path (perfect match, different shape)

**Access pattern:** Demo mode reads the entire pre-computed briefing + investigations, once, on page load. Writes happen only during a dev-only "capture this as the demo snapshot" flow (referenced in AGENTS.md).

**Store:** two committed JSON files — `lib/state/demo-insights.json` (~665 lines) and `lib/state/demo-investigations.json` (~3487 lines).

Walk the match:

- Write shape: rare, dev-only, whole-file replacement. Serialization cost doesn't matter.
- Read shape: on demo page load, `readFileSync + JSON.parse` for both files. At ~80KB total, that's a few milliseconds — well under any user-perceptible threshold.
- Query shape: none. The reader wants "the whole snapshot," and that's what's stored.

**The mismatch cost is zero.** This is the correct call. If you tried to store this in Postgres — 10 rows for insights, some for investigations, joins for the trace — the read-time cost would be higher (network + parse) and the deploy-time story would be more complex (migrations, seed data, environment parity). Committed JSON is a genuinely better shape for "the demo is our reliable presentation path."

**One subtle cost:** the demo snapshot is committed, so it moves through code review. If you regenerate it and get an inconsistent write (see `04-transactions-and-integrity.md`), a reviewer catches it in the diff. That's the operational-safeguard version of atomicity — it works for this workflow, it wouldn't work for a live-write path.

#### Path C — the eval path (partial mismatch — the interesting case)

**Access pattern:** *During* a run — each case produces one receipt, written independently. *After* a run — every aggregation (baseline, gate, report) reads all receipts for a runId, sums per-dimension pass rates, prints or writes the summary.

**Store:** file-per-record in `eval/receipts/`, filename encodes `(caseId, runId)`.

Walk the match:

- **Write shape (during run):** each case writes one file. Perfect independence — parallelizable, no shared state, no coordination. Match.
- **Read shape "one specific receipt":** filename encodes the key. `readFileSync(resolve(RECEIPTS_DIR, `${caseId}-${runId}.json`))` is O(1). Match.
- **Read shape "all receipts for a runId":** `readdirSync + filter-by-suffix + parse × N`. Match at 10 files; mismatch at 200; disaster at 2000.
- **Read shape "aggregate scores across every run":** no support. You'd have to walk every file, parse every one, extract just the dimension scores. This is the pure mismatch case.

```
  Eval-path store vs. queries — where the shape fits and where it doesn't

     query                             cost with file-per-record layout
     ─────                             ────────────────────────────────
     one specific receipt         →    O(1)  filename lookup            ✓
     all receipts for a runId     →    O(all_files) directory scan +
                                       O(k) parses                       ✓ at 10, ✗ at 200
     "which cases regressed?"     →    O(all_files) scan +
                                       full parse of every hit           ✗
     "trend a dimension over runs"→    O(all_files) scan +
                                       full parse of every hit           ✗

     ═══════════════════════════════════════════════════════════════
     the mitigation that exists: eval/baseline.json
     ───────────────────────────────────────────────────────────────
     one committed pre-aggregated summary → gate reads in O(1)
     (this is a materialized view — see file 03)
```

**What breaks the match at scale:** the second and third queries. Every gate run does two `readdirSync` calls (one to discover latest runId, one to filter for it), plus N parses. At 10 cases × 5 recent runs = 50 files, ~100ms. At 200 cases × 30 runs = 6000 files, several seconds *just to read the directory*, before any parse cost.

**The right store when that mismatch bites:** SQLite locally, Postgres if the eval subsystem becomes a shared service. A single table `runs(runId, caseId, dimension, score, verdict)` with indexes on `(runId)` and `(dimension, verdict)` makes every aggregation an indexed lookup. The migration is: keep receipts as blobs for full replay, but *also* extract the aggregation surface into a table. That's a genuine dual-storage pattern, and it's the natural next step.

#### Move 2 variant — the load-bearing skeleton of "store matches access"

Three parts. Drop any one and the mismatch tax starts to hurt.

1. **The access primitives are enumerated.** For each store, name every read and write pattern the app actually uses. If you skip this, you can't check the match — you're guessing.

2. **Each primitive maps to a single store operation.** `getInsight` maps to two Map hits. `readRun(runId)` — the abstraction that *should* exist in `eval/` — currently doesn't; every caller reimplements the scan. That's a smell (see file 03 too).

3. **The mapping's cost class is named.** O(1) for point lookups, O(k) for list-in-session, O(N) for whole-directory scans. When you can name the class, you can predict where the store breaks.

Drop part 1 and you have vague "I think this is fast enough." Drop part 2 and the abstraction leaks into every caller. Drop part 3 and you're surprised when performance falls off a cliff at some scale you didn't plan for.

### Move 3 — the principle

**"Do you need a database?" is the wrong first question. "What's the shape of every read and write?" is the right one.** Once you've enumerated the access pattern, the store choice is usually forced: point lookup by known id in a small dataset per user? A Map. Immutable log of events? A file-per-record directory. Range query by a value you don't own? An indexed table. Blooming_insights got its request path exactly right (Map matches perfectly), got its demo path exactly right (JSON matches perfectly), and got its eval path *half-right* — the write shape matches (file-per-record works for independent case runs), the read shape doesn't (aggregation is a filesystem scan). The rule you take home: **the right time to introduce a database is when your access pattern gains a query the current store can only answer by scanning.** Not before, not after.

## Primary diagram

Every store, every access pattern, side by side — showing where the match holds and where the mismatch tax will eventually hit.

```
  blooming_insights — access patterns and store shape

  ┌─ REQUEST PATH ──────────────────────────────────────────────┐
  │                                                              │
  │  access:  write-once, read-many-within-session               │
  │  store:   Map<sid, Map<id, T>>                               │
  │  match:   ✓ every primitive O(1) or O(k)                     │
  │  cost:    memory leak on very long-lived process (uncapped)  │
  │                                                              │
  └─────────────────────────────────────────────────────────────┘

  ┌─ DEMO PATH ─────────────────────────────────────────────────┐
  │                                                              │
  │  access:  read whole snapshot on page load                   │
  │  store:   single committed JSON file (per concept)           │
  │  match:   ✓ read = whole file = one parse                    │
  │  cost:    write atomicity across two files (see file 04)     │
  │                                                              │
  └─────────────────────────────────────────────────────────────┘

  ┌─ EVAL PATH ─────────────────────────────────────────────────┐
  │                                                              │
  │  access:  file-per-case-per-run + occasional aggregation     │
  │  store:   flat directory of ~35KB JSON files                 │
  │  match:   ✓ write (independent) · ✓ point-lookup             │
  │           ~ per-runId scan (OK today, ✗ at 10x scale)        │
  │           ✗ cross-run aggregation (no support)               │
  │  mitigation: baseline.json (materialized view for the gate)  │
  │  next step: SQLite when aggregation becomes frequent         │
  │                                                              │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The "match the store to the access" discipline is old — it's the pattern behind CQRS (write model separate from read model), materialized views (pre-shape the answer for a specific query), and secondary indexes (add a store shape to answer a query the primary shape can't). Blooming_insights runs the tiniest form of this: `baseline.json` is a hand-built materialized view over the receipts directory, tailored to exactly one query (the gate's per-dimension diff).

The eval-path partial mismatch is a real preview of the "when do I introduce a database?" moment. The trigger to watch for: **the second time you write `readdirSync + filter + parse × N` for a new question.** The first time is fine — it's a one-off. The second time you're building the same abstraction twice, and the answer is either factor out the read (`eval/receipts.ts`) or move to a real store. Right now the pattern is written three times (`baseline`, `gate`, `report`) — that's already over the threshold; the abstraction is overdue even before the store question.

Cross-link: the *which* database question ("Postgres vs SQLite vs Redis") is architectural — that belongs to `study-system-design/`. This file's contribution is the *shape* argument: the access pattern tells you whether you need a database at all, and when, and which shape (relational, document, KV) matches. The vendor choice comes after.

## Interview defense

**Q: "Why is there no database in this system?"**
Answer: "Because the access pattern doesn't need one. The request path is write-once-per-session, read-many-within-that-session — a two-level Map matches perfectly (session partition + entity id, both O(1)). The demo path is 'read the whole snapshot on load' — one committed JSON file matches perfectly. The eval path writes independently per case, which files-per-record match; the aggregation-across-runs read is where a store *would* help, and today we mitigate with `eval/baseline.json` as a materialized view for the regression gate. If cross-run trending becomes a feature, SQLite is the smallest next step." Draw the three-path diagram.

**Q: "When would you introduce a database?"**
Answer: "The trigger is the eval subsystem specifically. When any question emerges that can't be answered without scanning every receipt — 'trend evidence_grounding scores over the last month,' 'find every case where the gate blocked,' 'compare judge-error rates across model versions' — the file layout hits its wall. That's the moment for SQLite: one table `run_dimensions(runId, caseId, dimension, score, verdict)`, index on `(dimension, verdict)`, and every aggregation is O(log N)." Anchor: `eval/baseline.eval.ts:44-51` for the scan; `eval/baseline.json` for the current materialized-view workaround.

**Q: "Any current pattern that already smells like a missing store?"**
Answer: "Yes — the `readdirSync + filter-by-suffix + parse × N` block appears three times: `baseline.eval.ts`, `gate.eval.ts`, `report.eval.ts`. Three copies of the same scan is a strong signal the abstraction is missing. First move: factor `eval/receipts.ts` with `listRunIds()` and `readRun(runId)`. Second move (if aggregation frequency grows): back it with SQLite." Draw the three-copies pattern → one-abstraction move.

## See also

- `01-the-data-model-and-its-shape.md` — the shapes being stored.
- `03-indexing-vs-query-patterns.md` — the concrete cost of the eval-path scan.
- `07-data-modeling-red-flags-audit.md` — the "no persistent store" and "shape fights access" entries.
- `study-system-design/` — the *which* datastore question sits there (architecture), separate from *whether the shape fits* (here).

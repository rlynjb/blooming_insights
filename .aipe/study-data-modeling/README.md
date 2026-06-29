# Study — Data modeling

The through-line: **does the data's shape match how it's actually read and written, and can it stay correct?** Code is cheap to change; a schema with live data in it is not. Most "data modeling" advice assumes a database with rows and indexes. This repo doesn't have one — and that itself is the most load-bearing modeling decision in the codebase.

## What this guide audits

Persistent and quasi-persistent data here lives in three places:

1. **Type-only contracts** — the discriminated union (`AgentEvent`), the entity types (`Insight`, `Anomaly`, `Diagnosis`, `Recommendation`), and `WorkspaceSchema`. These are the schema; they live in `lib/mcp/types.ts` and `lib/mcp/events.ts`.
2. **In-memory state, session-keyed** — a `Map<sessionId, SessionFeed>` at `lib/state/insights.ts`. Volatile by design; the durability story is "the next briefing replaces it."
3. **JSON files on disk** — `lib/state/demo-insights.json` and `lib/state/demo-investigations.json` (committed, the demo replay snapshot); `.investigation-cache.json` and `.auth-cache.json` (dev-only, gitignored). No SQL, no migrations, no indexes.

Everything else — agent prompts, fixtures, env vars — is configuration, not data.

## The two partition seams (stated up front)

```
  Where data-modeling stops and other studies pick up

  ┌─ data modeling (HERE) ────────────────────────────┐
  │  SHAPE of persistent data:                         │
  │  schema · normalization · indexes · integrity      │
  └────────────────────────┬───────────────────────────┘
                           │ seam 1: "which datastore"
                           ▼
  ┌─ system design ────────────────────────────────────┐
  │  Postgres vs Redis vs files; replication;          │
  │  sharding; backups; durability tier                │
  └────────────────────────┬───────────────────────────┘
                           │ seam 2: "in-memory data structures"
                           ▼
  ┌─ DSA foundations ──────────────────────────────────┐
  │  the Map as a hash table; lookup is O(1)           │
  │  the algorithms, not the schema                    │
  └────────────────────────────────────────────────────┘
```

- **Against system-design.** "Use Postgres, shard by tenant" is architecture — over there. "This field is denormalized, here's why" is data modeling — here. The decision to *not* use a database lives in `06-access-patterns-and-storage-choice.md`.
- **Against DSA foundations.** A `Map<string, SessionFeed>` is a hash table; the *concept* of a hash table is DSA. The *contract* of what lives in that map and how it's keyed is data modeling.

## The schema diagram

This is the model as-built. Everything else in the guide hangs off it.

```
  blooming insights — the data model as-built

  ┌─ Type-only contracts (lib/mcp/types.ts, events.ts) ─────────────────┐
  │                                                                      │
  │  WorkspaceSchema  ── one per project, bootstrap-cached, ~immutable   │
  │     ├── events[]:           { name, properties[], eventCount }       │
  │     ├── customerProperties[]                                         │
  │     ├── catalogs[]                                                   │
  │     └── totalCustomers · totalEvents · oldestTimestamp               │
  │                                                                      │
  │  Anomaly ── monitoring agent output (the JSON the LLM emits)         │
  │     │      { metric, scope[], change{value,direction,baseline},      │
  │     │        severity, evidence[], impact?, history?, category? }    │
  │     ▼                                                                │
  │  Insight ── derived from Anomaly, plus id + timestamp + summary      │
  │     │      + denormalized affectedCustomers (from Diagnosis)         │
  │     │      + downstreamReady{diagnosis, recommendations}             │
  │     │                                                                │
  │     ├── 1 ─────► Diagnosis    (one per Insight, diagnostic agent)    │
  │     │             { conclusion, evidence[], hypothesesConsidered[],  │
  │     │               affectedCustomers?{count, segmentDescription} }  │
  │     │                                                                │
  │     └── 1 ─────► Recommendation[]  (many per Insight, recom. agent)  │
  │                   { id, title, rationale, bloomreachFeature,         │
  │                     steps[], estimatedImpact, confidence }           │
  │                                                                      │
  │  AgentEvent ── discriminated union, 8 variants, the wire format      │
  │     reasoning_step | tool_call_start | tool_call_end | insight |     │
  │     diagnosis | recommendation | done | error                        │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘
                              │
                              │  hydrate
                              ▼
  ┌─ In-memory state (lib/state/insights.ts) ───────────────────────────┐
  │                                                                      │
  │  Map<sessionId, SessionFeed>  ── outer map, never cleared            │
  │     │                                                                │
  │     └── SessionFeed                                                  │
  │           ├── insights:        Map<insightId, Insight>               │
  │           ├── investigations:  Map<insightId, Investigation>         │
  │           └── anomalies:       Map<insightId, Anomaly>  (parallel)   │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘
                              │
                              │  serialize for replay / persistence
                              ▼
  ┌─ JSON files on disk ────────────────────────────────────────────────┐
  │                                                                      │
  │  lib/state/demo-insights.json       { insights, workspace,           │
  │                                       coverage, trace } — committed  │
  │  lib/state/demo-investigations.json { [insightId]: AgentEvent[] }    │
  │                                       — committed                    │
  │  .investigation-cache.json          dev-only, gitignored             │
  │  .auth-cache.json                   dev-only, gitignored             │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘
```

## Reading order

1. **`01-the-data-model-and-its-shape.md`** — the entities and their relationships, drawn from `lib/mcp/types.ts`. The zoom-out.
2. **`02-normalization-and-duplication.md`** — `Anomaly` and `Insight` share four fields; `affectedCustomers` is duplicated from `Diagnosis` onto `Insight`. Which duplications are deliberate.
3. **`03-indexing-vs-query-patterns.md`** — the access patterns and what they index on. `Map`-by-id is the only "index" the repo has.
4. **`04-transactions-and-integrity.md`** — `parseAgentJson` + the type guards are the only integrity layer. No FKs, no checks.
5. **`05-migrations-and-evolution.md`** — there are no migrations. The optional-field discipline that lets the demo snapshot stay valid across releases.
6. **`06-access-patterns-and-storage-choice.md`** — the decision to not use a database, and why it's the right call for this repo today.
7. **`07-data-modeling-red-flags-audit.md`** — the consolidated checklist scored against this codebase.

## What you carry away

- The data model lives in **TypeScript types**, not a schema file. The types are the contract; the `Map`s are the storage.
- **Session isolation** is the only invariant the in-memory store has to enforce, and it does it by *never* clearing the outer map — that's the entire concurrency story.
- **There are no migrations because there's no schema.** The optional-field discipline is the substitute, and it's load-bearing for the committed demo snapshot.
- **The biggest red flag isn't in the data model** — it's the absence of a real one. Every page reload past the same warm Vercel instance shows yesterday's session's empty state; the demo snapshot is the persistence. Whether that's a bug or a feature is the central design call. See `06`.

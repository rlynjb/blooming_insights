# Study — Data Modeling

The shape of persistent data in **blooming_insights**: schema, duplication,
indexes vs queries, integrity, evolution, storage choice. The whole guide is
about one question — *does the data's shape match how it's actually read and
written, and can it stay correct?*

The twist for this repo: **there is no database.** State lives in in-memory
maps, gitignored JSON dev caches, and two committed JSON snapshots. The
"schemas" worth auditing are **TypeScript types** (`Insight`, `Anomaly`,
`Diagnosis`, `Recommendation`, `WorkspaceSchema`), the **session-keyed Map**
in `lib/state/insights.ts`, and the **inverted-pyramid event model** in the
two `DataSource` adapters (`BloomreachDataSource` live; `SyntheticDataSource`
deterministic).

```
  The through-line, in one picture

  ┌─ how the app READS data ───────────────────────────────┐
  │  ad-hoc EQL  →  evidence[]  →  Insight  →  card        │
  │  (90d vs prior 90d, every metric computed at run time) │
  └────────────────────────────────────────────────────────┘
                            │
                            ▼  does the shape match the read pattern?
  ┌─ how the app STORES data ──────────────────────────────┐
  │  no DB · session-keyed Map<sessionId, SessionFeed>     │
  │  dev: .auth-cache.json + .investigation-cache.json     │
  │  demo: lib/state/demo-{insights,investigations}.json   │
  └────────────────────────────────────────────────────────┘
```

The verdict up front: **the read shape and the store shape match — for now.**
Every metric is a fresh tool call, and "storage" is a cache of an
already-finished briefing. No JOINs, no migrations, no indexes. The risk
isn't that the schema is wrong; it's that **a few load-bearing invariants
are enforced in TypeScript types and demo JSON files with no DB to guard
them**. That's what the audit hunts.

---

## Where data modeling sits — and where it doesn't

Two seams keep this guide focused:

```
  data modeling     ← the SHAPE of persistent data: schema, normalization,    you are here
                      indexes, queries, integrity, evolution
  system design     WHICH datastore + scaling/sharding/replication
                    (architecture, not schema shape)
                    → .aipe/study-system-design/
  dsa foundations   IN-MEMORY data structures (heaps, trees, graphs)
                    → not this guide; lives elsewhere in the study family
  software design   information-hiding / duplication in CODE
                    (normalization is the DATA analog of that)
```

Two boundary calls to keep this guide tight:

- "Should we move from in-memory Maps to Postgres?" is a **system-design**
  question (which datastore). What that Postgres schema would look like is
  this guide.
- "Why does `lib/state/insights.ts` use a `Map<sessionId, SessionFeed>`
  instead of a flat `Map<insightId, Insight>`?" is this guide — it's about
  *data shape and access pattern*. The fact that the Map happens to live in
  memory doesn't make it a system-design question.

---

## Reading order

Start with the overview to see the whole picture, then walk the concept
files in number order. The audit is the capstone — read it last with the
mechanics from the concept files already loaded.

| # | File | What it covers |
|---|---|---|
| 0 | [`00-overview.md`](./00-overview.md) | One-page map of every data shape in the repo + the no-DB framing |
| | [`audit.md`](./audit.md) | The 7-lens checklist applied to this repo — capstone, read last |
| 1 | [`01-the-data-model-and-its-shape.md`](./01-the-data-model-and-its-shape.md) | The entities and how they relate — `WorkspaceSchema`, `Insight`, `Anomaly`, `Diagnosis`, `Recommendation`, `AgentEvent` |
| 2 | [`02-normalization-and-duplication.md`](./02-normalization-and-duplication.md) | What's stored twice on purpose (`Anomaly` → `Insight` enrichment), what's stored twice by accident |
| 3 | [`03-indexing-vs-query-patterns.md`](./03-indexing-vs-query-patterns.md) | How the in-memory Maps mirror access patterns; the `Map<id, Insight>` *is* the index |
| 4 | [`04-transactions-and-integrity.md`](./04-transactions-and-integrity.md) | Atomicity in serverless without a DB; per-session write isolation; the runtime validators |
| 5 | [`05-migrations-and-evolution.md`](./05-migrations-and-evolution.md) | How `Insight` evolves field-by-field — optional fields + the demo JSON as a frozen migration target |
| 6 | [`06-access-patterns-and-storage-choice.md`](./06-access-patterns-and-storage-choice.md) | Why a "no DB" choice is the right one here — the seam to system-design |

---

## What to expect

The voice is direct. The diagrams come first; prose fills in what diagrams
can't show. Every claim points at a real file path and line range — when a
field is enforced by a TypeScript type, the file is named; when an invariant
is *not* enforced anywhere, the audit calls it out by name.

Where the repo doesn't yet exercise a classical data-modeling concern (it
has no migrations because it has no schema to migrate), the file says so
honestly and shows the **buildable target** — what the concern would look
like the day the repo grows a real datastore.

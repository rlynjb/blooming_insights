# 04 — vector databases

**Subtitle:** Storage options for embeddings · Industry standard (Case B)

## Zoom out, then zoom in

**Case B.** Where the embeddings live for fast lookup. For blooming
insights' scale (~100s of investigations), the choice is between
`sqlite-vec` (stay file-based) and `pgvector` (introduce Postgres).

```
  Zoom out — vector store sits next to the corpus

  ┌─ Corpus (file-based today: lib/state/*.json) ───┐
  │                                                  │
  │  ┌─ NEW: vector store ─────────────────────────┐ │  ← we are here
  │  │  sqlite-vec  → keep file-based              │ │   (Case B)
  │  │  pgvector    → introduce Postgres           │ │
  │  │  Pinecone    → introduce managed service    │ │
  │  └──────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — operational weight.** sqlite-vec adds zero infra
    (single file); pgvector adds a database; Pinecone adds a network hop +
    a managed service. The order is "least new infra → most new infra";
    pick the lightest that scales to your foreseeable corpus.

## How it works

### Move 1 — the mental model

Same as picking a database: SQLite for "one file, no server, simple ops";
Postgres for "real database, joins, transactions"; managed service for
"someone else handles scale." For vectors specifically:

```
  Storage options (by corpus size)

  ┌────────────────────────┬─────────────────────────────┐
  │ Storage                │ When to use                 │
  ├────────────────────────┼─────────────────────────────┤
  │ in-memory + JSON       │ <1000 chunks, prototype     │
  │ sqlite-vec             │ local-first, single-tenant  │
  │  (SQLite extension)    │ no server needed            │
  │ pgvector               │ already on Postgres;        │
  │  (Postgres ext)        │ unifies relational + vector │
  │ Pinecone / Weaviate /  │ massive scale; multi-tenant │
  │  Qdrant / Chroma       │ managed infra OK            │
  └────────────────────────┴─────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**For blooming insights, sqlite-vec is the right choice.** Reasoning:

  → No database server exists in this codebase today. Adding one is real
    operational complexity (Vercel doesn't host Postgres natively; you'd
    need Supabase, Neon, or similar — and authentication, connection
    pooling, migrations).
  → Corpus is tiny (~100s of investigations even after a year of use).
    sqlite-vec handles up to ~1M vectors comfortably on a laptop.
  → The existing state files are JSON; the codebase already treats
    file-based state as primary in dev (`.investigation-cache.json`).
    sqlite-vec slots into the same shape.
  → Vercel deployment quirk: serverless functions don't have persistent
    file storage. The vector index has to live somewhere durable. Options
    for sqlite-vec on Vercel: commit the .sqlite file to git (works for
    read-mostly, demo-friendly); or migrate to Turso (sqlite-as-a-service,
    edge-friendly). For pure local dev + portfolio demo, committing is
    fine.

**The interface.** Whichever store you pick, the shape your app code sees
should be the same — adapter pattern again:

```typescript
// hypothetical lib/rag/store.ts
interface VectorStore {
  upsert(id: string, embedding: number[], metadata: Record<string, unknown>): Promise<void>;
  cosineSearch(query: number[], opts: { topK: number }): Promise<Array<{ id: string; score: number; metadata: Record<string, unknown> }>>;
  count(): Promise<number>;
}

class SqliteVecStore implements VectorStore { /* … */ }
class PgvectorStore implements VectorStore { /* … */ }
```

Swap the implementation; app code doesn't change.

**Why ANN matters at scale.** For ~1000 vectors, brute-force cosine is
fine — compute similarity vs every vector, sort, take top-k. For ~1M
vectors, this is too slow per query. Approximate Nearest Neighbor
algorithms (HNSW, IVF) build an index that trades a small accuracy
penalty (~1-5%) for ~100x faster queries. sqlite-vec uses HNSW; pgvector
uses IVF or HNSW depending on configuration. Both Pinecone and Weaviate
use ANN under the hood.

For blooming insights at current scale, brute-force is genuinely fine.
The ANN question matters past ~10k vectors.

### Move 3 — the principle

**Pick the lightest store that scales to your foreseeable corpus.
Operational complexity costs more than per-query latency at small scale.**
sqlite-vec gives you 80% of what Pinecone gives you, with zero added
infra. Reach for pgvector when you genuinely need joins between vector
and relational data; reach for managed when you genuinely need multi-
tenant scale.

## Primary diagram

```
  Vector store decision tree for blooming insights

  ┌─ corpus size? ──────────────────────────────────┐
  │                                                  │
  │  < 1000 vectors                                  │
  │    └─► in-memory + JSON or sqlite-vec            │
  │                                                  │
  │  1k - 1M vectors                                 │
  │    ├─► sqlite-vec (no db server)                 │
  │    └─► pgvector (if you already have postgres)   │
  │                                                  │
  │  > 1M vectors                                    │
  │    └─► Pinecone / Weaviate / Qdrant / pgvector   │
  │        with ANN tuning                           │
  │                                                  │
  └──────────────────────────────────────────────────┘

  blooming insights ─── sqlite-vec
   (current state)      (corpus <1k for years)
```

## Elaborate

The sqlite-vec extension (formerly sqlite-vss) hit v0 in 2023 and has
become the canonical "vectors in SQLite" answer. It supports cosine, L2,
and dot-product similarity, ANN via HNSW, and integrates with regular
SQLite tables for joins. The deployment story on Vercel is the awkward
part — serverless functions don't have writable file storage — but
read-mostly workloads (build a static index, query at runtime) work fine
when the .sqlite file is committed to git or hosted on edge storage.

For blooming insights' diagnosis-grounding case the access pattern is:
write-rarely (on each new investigation), read-on-every-diagnose. The
index is built incrementally, queried frequently. sqlite-vec's HNSW
update cost is acceptable for write-rarely workloads.

If the product ever grew to be multi-tenant SaaS with thousands of
workspaces and hundreds of millions of vectors, the migration target is
pgvector on a managed Postgres (Supabase, Neon, RDS). The adapter
interface above is what makes that migration a one-class swap.

## Project exercises

### Exercise — implement `SqliteVecStore` for the local index

  → **Exercise ID:** `study-ai-eng-03-04.1`
  → **What to build:** `lib/rag/store.ts` with a `VectorStore` interface
    and a `SqliteVecStore` implementation. Use `better-sqlite3` +
    `sqlite-vec`. Persist to `.rag-cache.sqlite` (gitignored in dev,
    committed for demo). Methods: `upsert`, `cosineSearch`, `count`.
    Wire from `lib/state/investigations.ts` to upsert on save.
  → **Why it earns its place:** Lands the storage layer for the
    diagnosis-grounding feature. Single file, no infra.
  → **Files to touch:** new `lib/rag/store.ts`, `lib/state/investigations.ts`
    (call upsert), `package.json` (`better-sqlite3`, `sqlite-vec`),
    `.gitignore` (add `.rag-cache.sqlite` for dev),
    `test/rag/store.test.ts`.
  → **Done when:** Saving an investigation upserts its vector;
    `cosineSearch` returns the most-similar prior investigation as top-1
    on a fixture.
  → **Estimated effort:** `1–2 days`

## Interview defense

**Q: Which vector database would you use for this codebase?**

`sqlite-vec`. Three reasons:

  1. No database server exists today; adding Postgres for ~100 vectors is
     operational overkill.
  2. The codebase already treats file-based state as primary
     (`.investigation-cache.json`, `lib/state/demo-*.json`). sqlite-vec
     slots into the same shape.
  3. The corpus stays small for years (one new investigation per
     anomaly-click). Brute-force or HNSW in SQLite handles it.

The adapter pattern (a `VectorStore` interface with a `SqliteVecStore`
impl) keeps pgvector / Pinecone as a future swap.

**Anchor line:** "sqlite-vec for the local store, adapter interface so
pgvector is a one-class swap when the corpus outgrows it."

**Q: When would you actually reach for Pinecone?**

When the corpus crosses ~1M vectors per tenant AND there's enough
multi-tenant traffic that the managed indexing pays for itself. For most
single-tenant apps and most internal tools, sqlite-vec or pgvector is
sufficient through several years of growth.

## See also

  → `01-embeddings.md` — what's being stored
  → `05-dense-vs-sparse.md` — what kind of search the store enables
  → `10-incremental-indexing.md` — how the store stays fresh

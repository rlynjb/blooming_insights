# 04 — Vector databases

**Type:** Industry standard. Also called: vector stores, ANN indexes, embedding databases.

## Zoom out, then zoom in

**Not exercised in this codebase.** If RAG were added at this repo's scale (~10K items), the answer would be flat JSON or SQLite — not Pinecone.

```
  Zoom out — where storage sits

  chunks + vectors ─► ★ vector store ★ ─► top-k cosine on query
```

Zoom in. The choice depends on scale. Under ~100K vectors, in-memory or SQLite with brute-force cosine is fast enough. Above that, ANN (approximate nearest neighbor) indexes matter. Managed vector DBs (Pinecone, Weaviate, Qdrant, Chroma) buy horizontal scale + zero ops, at the cost of a network hop and monthly fees.

## Structure pass

**Layers:**
- Outer: retrieval latency + recall
- Middle: index structure (flat, HNSW, IVF)
- Inner: storage backing (memory, SQLite, Postgres, dedicated DB)

**Axis: scale threshold.**
- < 10K vectors: brute-force in memory, ~1ms
- 10K-1M: SQLite / pgvector, still often brute-force
- 1M+: HNSW / IVF index required for sub-100ms queries

**Seam:** the query function — `search(queryVector, k)` returns top-k. Above: retrieval logic. Below: whichever store.

## How it works

### Move 1 — the mental model

You've picked between SQLite, Postgres, and a managed DB before. Same axes: scale, ops burden, features. Vector DBs add one more: is the index in-memory (fast, memory-bound) or on-disk (slower, unlimited)?

```
  Options at typical scales

  <1K       flat JSON, load into memory        <— this repo's would-be scale
  <100K     pgvector or sqlite-vec              
  <10M      Pinecone / Weaviate / Qdrant / pgvector w/ HNSW
  >10M      dedicated infra + sharding
```

### Move 2 — walk the mechanism

**Options at each scale.**

- **In-memory + JSON.** The simplest. Load all vectors on boot, brute-force cosine on query. Fine up to ~10K vectors on typical hardware. Zero ops. Restart loses nothing (rebuild from source of truth).
- **SQLite + `sqlite-vec` extension.** Local-first, no server. Great for CLI tools and offline apps. Reasonable for ~100K vectors.
- **Postgres + `pgvector`.** Postgres already in your stack? Add the extension and unify relational + vector queries. HNSW index for sub-linear queries at scale. Best all-around answer for most production apps.
- **Managed vector DBs (Pinecone, Weaviate, Qdrant, Chroma).** Zero ops, hosted, multi-tenant. Extra network hop. Costs.

**For this codebase's would-be corpus.**

Past diagnoses at ~10K items with ~5 chunks each = 50K vectors, ~1536 floats each = ~300MB in memory (as Float32). Loadable, brute-force is fine, zero infra. A JSON file at `lib/state/embeddings.json` alongside `demo-*.json` is the boring right answer.

If the corpus grew past 100K vectors, SQLite + `sqlite-vec` would be the next step. Both are local, no server, no ops.

**What ANN buys.**

At scale, exhaustive cosine over millions of vectors is slow (100ms+ per query). ANN indexes (HNSW = hierarchical navigable small world, IVF = inverted file) give approximate top-k in ~1-10ms. Trade: some recall loss (0.5-2% typically) for order-of-magnitude speedup. Not needed at this repo's scale.

### Move 3 — the principle

Start with brute force. Add an index when brute force stops meeting your latency target. Don't reach for Pinecone at 10K vectors — you're adding a network hop, monthly cost, and vendor lock-in for zero speed benefit.

## Primary diagram

```
  Storage options — pick by scale

  ┌─ this repo's scale (~10K vectors) ────────────────────────────────┐
  │  in-memory JSON, brute-force cosine                                │
  │  · latency: ~1-5ms per query                                       │
  │  · ops: zero (rebuild on boot)                                     │
  │  · cost: zero                                                      │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ scale-up path (~100K-1M) ────────────────────────────────────────┐
  │  SQLite + sqlite-vec  OR  Postgres + pgvector                      │
  │  · latency: ~10-50ms                                               │
  │  · ops: schema + index                                             │
  │  · cost: (whatever DB you already have)                           │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ enterprise scale (~1M+) ─────────────────────────────────────────┐
  │  Pinecone / Weaviate / Qdrant                                      │
  │  · latency: ~10-100ms + network                                    │
  │  · ops: managed by vendor                                          │
  │  · cost: $$$/month                                                 │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

The vector DB market grew fast (Pinecone, Weaviate, Chroma, Qdrant, LanceDB, etc.) and is consolidating. The pragmatic move is often to skip dedicated vector DBs and use pgvector — you already have Postgres in your stack. Costs less, no new vendor, and pgvector's HNSW is competitive at typical scales.

## Project exercises

### Exercise — in-memory brute-force vector store

- **Exercise ID:** C2.7-B · Case B (RAG not exercised).
- **What to build:** `lib/rag/store.ts` — loads `lib/state/embeddings.json` on init, exposes `search(queryVector, k)` doing brute-force cosine. No index, no server.
- **Why it earns its place:** the right choice for this repo's scale; proves you don't over-engineer. Interviewer signal: "I picked the simplest thing that works at my scale."
- **Files to touch:** `lib/rag/store.ts` (new), `lib/state/embeddings.json` (populated by the embed step).
- **Done when:** `search(queryVec, 3)` returns 3 top matches with cosine scores in < 5ms for a 500-vector corpus.
- **Estimated effort:** <1hr.

## Interview defense

**Q: Why not Pinecone?**

Because at 10K vectors, brute-force cosine in memory is 1-5ms. Pinecone would add ~50-100ms network hop + a monthly bill + a vendor lock-in for zero speedup. Pinecone earns its keep at millions of vectors, not thousands.

**Q: What's HNSW?**

Approximate-nearest-neighbor index. Builds a graph of vectors, traverses it hierarchically to find approximate top-k without scanning everything. Sub-linear query time. Standard at scale — pgvector supports it, all managed vector DBs use variants. Small recall cost (0.5-2%) for order-of-magnitude speedup.

**Q: When would you move off in-memory JSON?**

When it stops fitting in RAM (~1M+ vectors of 1536-dim = ~6GB, still fits on a modern node), or when you need to serve from multiple processes and can't share memory. That's SQLite / pgvector territory. Managed DB only when horizontal scale-out matters.

## See also

- `01-embeddings.md` — the vectors this stores
- `03-chunking-strategies.md` — what gets stored
- `10-incremental-indexing.md` — the ongoing maintenance

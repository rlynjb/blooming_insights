# Vector databases

## Subtitle

Approximate nearest neighbor storage / vector index — Industry standard.

## Zoom out, then zoom in

This codebase has no database at all — state lives in in-memory maps, with gitignored JSON files (`.auth-cache.json`, `.investigation-cache.json`) as dev-persistence. If retrieval landed, the vector-DB question would be a real choice; today it's a preview.

```
  Zoom out — where the vector store would sit

  ┌─ Agent ─────────────────────────────────────────────┐
  │  needs "find similar diagnoses to this anomaly"      │
  └───────────────────────┬──────────────────────────────┘
                          │  query(vec, k=3)
                          ▼
  ┌─ Vector store (new) ★ ──────────────────────────────┐
  │  candidate #1: sqlite-vec (local, file-backed)       │
  │  candidate #2: pgvector (if Postgres added)          │
  │  candidate #3: in-memory JSON + brute force          │
  └──────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** vector → index → distance function → top-k → results. Five bands.
- **Axis: scale.** Under ~1k vectors: brute force is fine. 1k–100k: local index (sqlite-vec, in-process HNSW). 100k+: dedicated vector DB.
- **Seam:** the storage boundary. Where the vectors live decides everything downstream about latency, cost, and ops.

## How it works

### Move 1 — the mental model

The comparison table:

```
  Vector storage options — where each wins

  ┌───────────────────┬──────────────────────────────┐
  │ storage           │ when it wins                 │
  ├───────────────────┼──────────────────────────────┤
  │ In-memory + JSON  │ <1000 vectors; prototype     │
  │                   │ scale; no infra              │
  ├───────────────────┼──────────────────────────────┤
  │ sqlite-vec        │ Local-first apps; file-      │
  │  (SQLite ext)     │ backed; no server            │
  ├───────────────────┼──────────────────────────────┤
  │ pgvector          │ Already on Postgres; unifies │
  │  (Postgres ext)   │ relational + vector queries  │
  ├───────────────────┼──────────────────────────────┤
  │ Pinecone / Qdrant │ Massive scale; dedicated     │
  │ Weaviate / Chroma │ vector infra; multi-tenant   │
  └───────────────────┴──────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**For blooming today.** In-memory brute force. The state layer is already in-memory with JSON dev-persistence (`lib/state/*.ts`); adding a `Map<id, { vec, inv }>` is one file. Brute force over 10k vectors is <10ms cosine similarity — well under any user-visible latency budget.

**When to upgrade to sqlite-vec.** When investigation-memory volume crosses ~10k rows *and* the dev/prod state model shifts from JSON to SQLite. sqlite-vec adds an HNSW index and vector functions to standard SQLite. No new infrastructure.

**When to upgrade to a hosted DB.** If blooming ever added multi-tenant hosted deployments where each tenant has their own investigation history and query latency matters at scale. Not on the near-term roadmap.

**How the in-memory brute-force version would look.** Pseudocode:

```
  index = Map<id, { vec: Float32Array, inv: Investigation }>

  add(inv):
    vec = embed(text(inv))
    index.set(inv.id, { vec, inv })

  query(text, k=3):
    q = embed(text)
    scored = []
    for [id, { vec, inv }] of index:
      score = cosine(q, vec)
      scored.push({ id, score, inv })
    scored.sort(by score desc)
    return scored.slice(0, k)
```

10k vectors × 1536 dims × 4 bytes = ~60 MB. Fits in memory. Full-scan cosine at 10k rows: a few ms.

### Move 2.5 — current state vs future state

Today: no vector store. Not a gap — no retrieval feature yet needs one.

Future (if past-investigation memory lands per `B3.1`): in-memory Map + JSON persistence, following the same pattern as `lib/state/investigations.ts`. If volume grows past 10k rows or persistence becomes multi-instance (Vercel deploy), sqlite-vec would be the upgrade.

### Move 3 — the principle

Storage is a solved problem when the vector count is small. Don't over-engineer the vector store; pick the smallest thing that fits and upgrade when volume or latency demands it.

## Primary diagram

```
  Vector storage decision — full frame

  ┌─ Vector count ─────────────────────────────────────┐
  │  <1k          → in-memory Map, brute force          │
  │  1k-100k      → sqlite-vec (local, HNSW)            │
  │  100k+        → pgvector (if PG present)            │
  │  1M+          → hosted (Pinecone / Qdrant / etc)    │
  └────────────────────────────────────────────────────┘

  Blooming today: 0 vectors → no store needed
  Blooming w/ investigation memory: 10k projected → sqlite-vec
  Blooming w/ catalog retrieval: 10k-100k → sqlite-vec still fits
```

## Elaborate

Vector databases were a category that didn't exist in 2020 and dominated infra discussions in 2023. Most of the hype has settled: for corpora under ~100k vectors, local storage is fine; for larger corpora with high query rate, hosted or embedded HNSW (via `hnswlib`) is the standard.

Related: **11-rag.md** (the store feeds retrieval), **10-incremental-indexing.md** (how the store gets updated).

## Project exercises

### B3.4 · Add in-memory + JSON-persisted investigation index

- **Exercise ID:** B3.4 (Case B — not yet implemented)
- **What to build:** Implement the vector store per the pseudocode above: `Map<id, { vec, inv }>` + JSON file dev-persistence + in-memory prod. Cosine similarity brute force. Follows `lib/state/investigations.ts`'s exact pattern.
- **Why it earns its place:** Smallest thing that works. Ships in ~200 LOC. Interview payoff: "I know exactly when to upgrade to sqlite-vec (10k+ rows or multi-instance persistence)."
- **Files to touch:** New `lib/state/investigation-index.ts`, dev-only `.investigation-index.json` (gitignored).
- **Done when:** cosine similarity search returns top-3 in <10ms for 10k vectors; JSON file survives dev restarts.
- **Estimated effort:** `1–2 days`.

## Interview defense

**Q: You'd start with in-memory? Isn't that obviously wrong?**

For 10k rows on a single Node.js process, no — brute-force cosine is milliseconds and memory is ~60 MB. The load-bearing part: recognize when the "obvious" infrastructure (a whole vector DB) is over-engineering for the actual volume. I'd upgrade to sqlite-vec at 100k rows or when the deploy model becomes multi-instance.

**Q: What about Pinecone?**

Not for this codebase's scale. Pinecone starts making sense at 1M+ vectors and multi-tenant. Blooming's corpus, even at maximum growth, is 3–4 orders of magnitude below that. Load-bearing: pick the tool that matches the load.

## See also

- [11-rag.md](11-rag.md) — the store powers the whole pipeline.
- [10-incremental-indexing.md](10-incremental-indexing.md) — how updates flow.
- [../06-production-serving/04-rate-limiting-backpressure.md](../06-production-serving/04-rate-limiting-backpressure.md) — the ops discipline that also decides when to upgrade.

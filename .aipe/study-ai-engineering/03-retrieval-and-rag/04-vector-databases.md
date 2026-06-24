# Vector databases (where the vectors live and how nearest-neighbor scales)

**Industry name(s):** vector database, vector index, approximate nearest neighbor (ANN), similarity search engine
**Type:** Industry standard · Language-agnostic

> A vector database stores embeddings and answers "give me the k nearest to this query vector" — by brute-force scan at small scale and by an approximate index (HNSW/IVF) at large scale; blooming insights stores no vectors, but its in-memory `Map` cache and module-level state are exactly the "in-memory, <1k items" tier where you do not need a vector DB at all.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** A vector database is the *storage tier* of a retrieval pipeline that blooming insights does not yet have. Where embeddings define what goes in and chunking defines what counts as one row, the vector store decides how those rows are held and scanned: an in-memory `Map`, a SQLite extension, or a managed service like Pinecone. The codebase already uses the same shape of in-memory `Map` for caches (`McpClient` TTL cache at `lib/mcp/client.ts` L18, schema cache at `lib/mcp/schema.ts` L130) — same primitive, different payload.

```
  Zoom out — where the vector store sits (WOULD BE)

  ┌─ Indexer (embed + chunk) ────────────────────────┐
  │  produces (id, vector, metadata) rows             │
  └─────────────────────────┬────────────────────────┘
                            │  write
  ┌─ Vector store ──────────▼────────────────────────┐  ← we are here
  │  ★ THE TIER DECISION ★                            │
  │  <1k:   Map<id, vector>        (scan-all)          │
  │  ~10k:  SQLite + sqlite-vss     (B-tree + ANN ext) │
  │  >100k: managed (Pinecone, etc.) (HNSW/IVF)        │
  └─────────────────────────┬────────────────────────┘
                            │  read (top-k)
  ┌─ Retriever ─────────────▼────────────────────────┐
  │  embed(query) → nearest-k → feed to LLM context   │
  └──────────────────────────────────────────────────┘

  In this codebase: Not yet implemented — String.includes
  intent matching in lib/agents/intent.ts is what exists
  instead; the in-memory Map pattern is already used for
  caches (mcp/client.ts L18, mcp/schema.ts L130).
```

**Zoom in — narrow to the concept.** The question is: how do you find the k nearest vectors to a query among millions, fast enough to serve a request? At small scale this is a `for` loop over an array — microseconds for 80 schema terms. At large scale the loop is too slow, and the entire reason vector databases exist is to make it *approximate-but-fast* via HNSW or IVF indices. How it works walks the tier ladder (Map → SQLite → managed), the exact-vs-approximate tradeoff, and the engineering rule of not adopting a vector DB before the scan stops being microseconds.

---

## Structure pass

**Layers.** Three WOULD-BE storage tiers stacked by scale: in-memory `Map` (<1k vectors, brute-force scan), SQLite + sqlite-vss (~10k, B-tree + ANN extension), and managed service like Pinecone (>100k, HNSW/IVF). Above all three sits the indexer that writes; below all three sits the retriever that reads top-k. blooming insights already uses the in-memory `Map` pattern for caches — different payload, same primitive.

**Axis: cost.** What does each tier pay per query as the corpus grows? This axis is the right lens because the entire file is a *cost-vs-scale* tier ladder — each tier earns its place at a different N. Lifecycle is constant (everything is per-query at the retriever); the only variable is "how much does a query cost at this corpus size."

**Seams.** The cosmetic seam is between the indexer and any one tier — write is the same shape everywhere. The load-bearing WOULD-BE seams are *between tiers*: scaling from Map to SQLite to managed each represents a cost-vs-precision flip (brute-force exact → approximate-but-fast). The most consequential is Map → ANN: cost flips from O(N) per query (acceptable below 1k) to O(log N) — and *exact* answers flip to *approximate* answers. blooming insights sits firmly in the "Map tier you don't need a vector DB at all" zone.

```
  Structure pass — vector databases (WOULD BE)

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  Map<id, vector> (<1k, brute-force)            │
  │  SQLite + sqlite-vss (~10k, ANN ext)           │
  │  managed (Pinecone, >100k, HNSW/IVF)           │
  │  (above: indexer; below: retriever top-k)      │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  cost: what does each tier pay per query as    │
  │  the corpus grows?                             │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  indexer↔any tier: cosmetic                    │
  │  Map↔ANN: LOAD-BEARING                         │
  │    O(N) exact → O(log N) approximate           │
  │    don't cross until microseconds stop working │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** A vector database is two things bolted together: a place to *store* float arrays (like a `Map` or a JSON file in the state layer) and an *index* that answers nearest-neighbor queries without scanning everything. At small scale the storage is a `Map` and the "index" is sorting computed cosines. At large scale the storage is on disk and the index is an approximate graph.

```
  scale          storage              nearest-neighbor method
  ────────────   ──────────────────   ───────────────────────────
  < 1k vectors   Map / JSON file      brute force: cosine all, sort
  < 1M           SQLite + extension   brute force or simple index
  > 1M           vector DB            ANN index (HNSW / IVF), approx
```

The body walks from the tier blooming insights already lives in up to the tier that needs a real DB.

---

### Tier 0: the in-memory `Map` (where this system already lives)

For tens to low-thousands of vectors, store them in a `Map<id, Float32Array>` and answer a query by computing cosine against every entry and sorting. This is exact (it checks all of them) and needs zero new infrastructure. This codebase already runs this pattern for non-vector data: the MCP client wrapper's TTL cache and the schema cache are both in-memory `Map`-backed stores.

```
  vectors: Map<id, Float32Array>          (lives in the process, same shape as the TTL cache)
  query q:
    for each [id, v] in vectors:          ← brute-force scan
        score[id] = cosine(q, v)
    sort by score desc, take top-k
```

The cost is O(N·d) per query — N vectors times d dimensions. At N=80, d=1536 that is ~123k multiply-adds: instant. This tier is correct and you should resist leaving it.

### Tier 1: persistence (JSON file / SQLite)

The `Map` dies on process restart and on a serverless cold start (the exact limitation called out for the TTL cache). To survive restarts you persist the vectors — a JSON file (like the dev-mode investigation snapshot file) or SQLite with a vector extension (`sqlite-vss`, `sqlite-vec`). Storage survives; the query is still a brute-force scan loaded into memory.

```
  STATE LAYER (same dev-file persistence pattern the in-process state map already uses)
  vectors.json ──load──▶ Map ──scan──▶ top-k
       │ survives restart
```

This is where the "search past investigations" feature would start: a JSON file of chunk vectors, loaded and scanned. No vector DB yet.

### Tier 2: the approximate index (HNSW / IVF)

Past ~1M vectors the brute-force scan is too slow per query. The fix is an *approximate* nearest-neighbor index that searches a structure instead of every vector:

```
  HNSW (graph)                          IVF (clustering)
  ──────────────────────────            ──────────────────────────────
  vectors are nodes in a layered        vectors grouped into clusters;
  graph; a query walks greedily         query checks only the nearest
  toward nearer neighbors               few clusters, not all vectors
       │                                     │
       └── O(log N) hops, approximate        └── scan a fraction, approximate
```

Both return *probably* the true top-k, not certainly — that is the trade for sub-linear speed. "Recall@k" measures how often the approximate result matches the exact one; you tune index parameters to hold recall while gaining speed.

### Tier 3: the full vector database

A vector database (Pinecone, Weaviate, Qdrant, pgvector) is the ANN index *plus* the operational layer: persistence, horizontal scaling, metadata filtering (retrieve nearest vectors *where* `insightId = X`), hybrid scoring (`06-hybrid-retrieval-rrf.md`), and incremental upserts (`10-incremental-indexing.md`).

```
┌──────────────────────────────────────────────┐
│  vector database                              │
│   ANN index (HNSW/IVF)   ← speed              │
│   metadata store         ← filter by field    │
│   persistence + scaling  ← survive + grow     │
│   upsert / delete        ← incremental index  │
└──────────────────────────────────────────────┘
```

This is the right tier only when scale and operational needs justify it — millions of vectors, multi-tenant filtering, continuous updates.

### The principle

Nearest-neighbor is a `for` loop until the `for` loop is too slow, and the entire vector-database industry exists to replace that loop with an approximate index once it is. The corollary is the one engineers most often miss: at small scale you do not need a vector database, you need the `Map` you already have — the same judgment the MCP client wrapper made by caching in memory instead of standing up Redis.

---

## Vector databases — diagram

This diagram spans the Service layer (the query) and the State layer (where vectors live across tiers). A reader who sees only this should grasp that storage and the nearest-neighbor method change with scale, and that blooming insights already lives in Tier 0.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER  (would live in lib/mcp/, like schema.ts)            │
│   query term ──▶ embed ──▶ q ──▶ nearest-neighbor(q, k)            │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ method depends on tier
┌──────────────────────────▼───────────────────────────────────────────┐
│  STATE LAYER  (lib/state/, lib/mcp/)                                │
│                                                                      │
│  TIER 0  Map<id, vec>          ← blooming insights ALREADY here     │
│                   │
│          brute-force scan, exact, zero infra                       │
│                                                                      │
│  TIER 1  JSON / SQLite         ← survives restart                  │
│          (like demo-investigations.json)                           │
│          brute-force scan loaded into memory                       │
│                                                                      │
│  TIER 2  ANN index (HNSW/IVF)  ← > 1M vectors                      │
│          approximate, sub-linear                                    │
│                                                                      │
│  TIER 3  vector DB             ← + filtering, scaling, upserts      │
│          (Pinecone/Qdrant/pgvector)                                │
└──────────────────────────────────────────────────────────────────────┘
```

The arrow down the State layer is the upgrade path; you climb it only when the tier above runs out, not by default.

---

## Implementation in codebase

**Not yet implemented.** blooming insights retrieves live via MCP tool calls + EQL against Bloomreach, not by querying a vector store — there are no vectors and no nearest-neighbor index anywhere.

The honest analog is that the codebase already runs the *storage tier* a small vector index would use. `McpClient`'s cache is an in-memory `Map<string, {result, expiresAt}>` (`lib/mcp/client.ts` L18); the schema is held in a module-level `let cached: WorkspaceSchema | null` (`lib/mcp/schema.ts` L130); past investigations persist to JSON (`lib/state/investigations.ts` reads `demo-investigations.json` and a dev cache file). That is precisely the "in-memory / JSON, <1k items, brute-force scan" tier where a vector database is unnecessary — you store in a `Map` or a JSON file and scan. A vector store would live in `lib/state/` (the file tier) graduating to a managed DB only at scale. The `Project exercises` block below is the primary buildable target.

---

## Elaborate

### Where this pattern comes from

Approximate nearest neighbor predates LLMs by decades — it powered image search, recommendation, and deduplication (FAISS from Meta, 2017; Annoy from Spotify). The RAG wave turned ANN into a product category: Pinecone, Weaviate, Qdrant, Milvus, and Chroma packaged the index with persistence and APIs. The countertrend matters too: pgvector (Postgres extension) and SQLite vector extensions let teams keep vectors in the database they already run, and the "you might not need a vector DB" argument — scan in-memory until you cannot — became the standard cost-discipline advice.

### The deeper principle

```
  data size        right tool              why
  ──────────────   ────────────────────    ───────────────────────────
  fits in a Map    Map + brute-force scan   exact, zero infra
  fits on disk     SQLite/pgvector          one store, transactional
  millions+        dedicated vector DB      ANN index + scaling
```

The progression mirrors every storage decision: a `Map` before a file, a file before a database, a single DB before a distributed one. Reaching for the top tier first is the recurring over-engineering mistake — and the codebase already avoids it for its cache by choosing a `Map` over Redis.

### Where this breaks down

1. **In-memory dies on cold start.** Tier 0's `Map` (and `McpClient`'s cache) is empty after a serverless cold start or restart — every vector must be re-loaded or re-embedded. The same limitation the caching guide notes for `McpClient` applies to an in-memory vector index.

2. **Brute force is O(N) — fine until it is not.** The scan is invisible at thousands and a request-killer at millions. There is no warning; latency just climbs with N until a query misses its budget.

3. **Approximate means *approximate*.** An ANN index can miss the true nearest neighbor. For most retrieval that is fine (recall@k near 1.0), but for correctness-critical lookups the approximation is a silent error you must measure (recall), not assume.

### What to explore next

- **Incremental indexing** (`10-incremental-indexing.md`): how vectors get added/updated/deleted in the store without a full rebuild.
- **Hybrid retrieval** (`06-hybrid-retrieval-rrf.md`): combining the vector index with keyword scoring — what real vector DBs do internally.
- **Chunking** (`03-chunking-strategies.md`): chunk count is the N that decides which tier you need.

---

## Project exercises

### Build a Tier-0 in-memory vector index for schema terms

- **Exercise ID:** B2A.1 / B2A.2 (adapted) — the primary buildable target.
- **What to build:** a `VectorStore` class backed by a `Map<id, Float32Array>` (mirroring `McpClient`'s cache shape) with `add(id, vec, metadata)` and `nearest(q, k)` that brute-force scans cosine and returns the top-k with metadata. Use it to index the embedded schema terms from `01-embeddings.md`. Deliberately stay at Tier 0 and document why no vector DB is warranted.
- **Why it earns its place:** demonstrates you know nearest-neighbor is a `for` loop at small scale and that you resist provisioning infrastructure you do not need — the cost-discipline interview signal.
- **Files to touch:** new `lib/mcp/vector-store.ts` (the `Map`-backed store), `lib/mcp/embeddings.ts` (feeds it), new `test/mcp/vector-store.test.ts` (nearest returns correct top-k).
- **Done when:** `store.nearest(embed("sales"), 3)` returns `purchase` first against the real schema, the store holds all schema terms in memory, and a comment justifies the Tier-0 choice for current scale.
- **Estimated effort:** 1–4hr

### Add Tier-1 persistence so the index survives a restart

- **Exercise ID:** B2A.2 (adapted) — persistence tier.
- **What to build:** persist the `VectorStore` to a JSON file on the same dev-file pattern as `lib/state/investigations.ts` (write in development, load on boot), so the index survives a restart without re-embedding. Keep the query a brute-force in-memory scan after load.
- **Why it earns its place:** shows you understand the cold-start limitation of in-memory state (the same one `McpClient`'s cache has) and the minimal persistence fix before any vector DB.
- **Files to touch:** `lib/mcp/vector-store.ts` (load/save), `lib/state/` (the JSON file), `test/mcp/vector-store.test.ts` (round-trip persistence).
- **Done when:** vectors written once are loaded from disk on a fresh process and `nearest` returns identical results without re-embedding.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"What vector database would you use?" is often a trap — the senior answer starts with "do I need one yet?" It tests whether you know nearest-neighbor is a brute-force scan at small scale and that vector DBs earn their cost only past a real scale threshold. The signal is naming the tiers, citing the in-memory-then-disk-then-DB progression, and connecting it to the `Map`-not-Redis judgment.

### Likely questions

**[mid] How does nearest-neighbor search actually work at small scale?**

Brute force: store vectors in a `Map` or array, and for each query compute cosine against every stored vector and sort descending for the top-k. It is O(N·d) — exact, simple, instant at thousands of vectors. No index, no database needed.

```
for each [id, v] in store: score[id] = cosine(q, v)
sort desc → top-k     (exact, O(N·d))
```

**[senior] When does the brute-force scan stop working, and what replaces it?**

When N grows past roughly a million, the O(N) scan exceeds the request latency budget. The replacement is an approximate nearest-neighbor index — HNSW (a navigable graph, O(log N) hops) or IVF (cluster-then-scan-a-few) — which returns *probably* the top-k for sub-linear speed. You measure the trade as recall@k.

```
N small  → brute force (exact)
N huge   → HNSW/IVF (approximate, sub-linear, measure recall)
```

**[arch] You're adding "search past investigations." Do you provision a vector DB?**

No — not for dozens to hundreds of investigations. That fits the tier the codebase already uses: a `Map` in memory (like `McpClient.cache`, `lib/mcp/client.ts` L18) or a JSON file (like `lib/state/demo-investigations.json`), scanned exhaustively. Provision a vector DB only when the corpus outgrows memory or the scan misses its latency budget. Reaching for one now is the Redis-for-a-`Map` mistake.

```
~100 investigations → Map/JSON scan (Tier 0/1)
millions of chunks  → vector DB (Tier 3)
```

### The question candidates always dodge

**"Do you actually need a vector database?"** Most candidates assume RAG implies a vector DB and skip the question. The senior answer is "usually not at first" — at <1k vectors a brute-force `Map` scan is exact, instant, and zero-infrastructure, and you climb to SQLite/pgvector and then a dedicated DB only as scale forces it. Naming the threshold (≈10⁵–10⁶ vectors) is the signal.

### One-line anchors

- `lib/mcp/client.ts` L18 — `McpClient.cache`: the in-memory `Map` tier a small vector index would use.
- `lib/mcp/schema.ts` L130 — `let cached: WorkspaceSchema`: module-level in-memory state.
- `lib/state/investigations.ts` — JSON-file persistence: the Tier-1 storage shape already in use.
- Nearest-neighbor is a `for` loop until it is too slow; then ANN.
- <1k vectors needs a `Map`, not a vector DB — the Redis-for-a-`Map` judgment.

---

## See also

→ 01-embeddings.md · → 03-chunking-strategies.md · → 10-incremental-indexing.md · → 11-rag.md
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).

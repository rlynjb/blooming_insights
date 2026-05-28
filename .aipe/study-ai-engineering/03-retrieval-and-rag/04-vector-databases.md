# Vector databases (where the vectors live and how nearest-neighbor scales)

**Industry name(s):** vector database, vector index, approximate nearest neighbor (ANN), similarity search engine
**Type:** Industry standard · Language-agnostic

> A vector database stores embeddings and answers "give me the k nearest to this query vector" — by brute-force scan at small scale and by an approximate index (HNSW/IVF) at large scale; blooming insights stores no vectors, but its in-memory `Map` cache and module-level state are exactly the "in-memory, <1k items" tier where you do not need a vector DB at all.

**See also:** → 01-embeddings.md · → 03-chunking-strategies.md · → 10-incremental-indexing.md · → 11-rag.md

---

## Why care

blooming insights already keeps a `Map<string, {result, expiresAt}>` on `McpClient` (`lib/mcp/client.ts` L18) and a module-level `let cached: WorkspaceSchema | null` in `lib/mcp/schema.ts` L130. Those are the storage tier a small retrieval system uses too — a plain in-memory `Map` of vectors, scanned exhaustively on every query. You only graduate to a "vector database" when the `Map` gets too big to scan or too big to fit in memory. So the real question is not "which vector DB" but "do I even need one yet?"

The question a vector database answers is: how do you find the k nearest vectors to a query among millions, fast enough to serve a request?

**The pivot: nearest-neighbor at small scale is a `for` loop over an array; at large scale that loop is too slow, and the entire reason vector databases exist is to make it approximate-but-fast.** Scanning 80 schema-term vectors is microseconds. Scanning ten million is hundreds of milliseconds per query — too slow. A vector index (HNSW, IVF) trades exactness for speed: it returns *probably* the nearest k by searching a clever graph or cluster structure instead of every vector. The DB is the index plus persistence, filtering, and operations.

Before a vector store decision:
- You assume "RAG means I need Pinecone/a vector DB"
- You provision a managed vector service for 80 schema terms
- You pay and operate infrastructure for a `for` loop's worth of data

After:
- You recognize the tier: <1k vectors fits the `Map` you already use
- You scan exhaustively — exact, simple, zero new infrastructure
- You adopt a vector DB only when the scan gets too slow or the data outgrows memory

It is the same instinct as not reaching for Redis when a `Map` cache suffices — which is exactly the choice `McpClient` already made.

---

## How it works

**Mental model.** A vector database is two things bolted together: a place to *store* float arrays (like the `Map` or the JSON files in `lib/state/`) and an *index* that answers nearest-neighbor queries without scanning everything. At small scale the storage is a `Map` and the "index" is `Array.prototype.sort` over computed cosines. At large scale the storage is on disk and the index is an approximate graph.

```
  scale          storage              nearest-neighbor method
  ────────────   ──────────────────   ───────────────────────────
  < 1k vectors   Map / JSON file      brute force: cosine all, sort
  < 1M           SQLite + extension   brute force or simple index
  > 1M           vector DB            ANN index (HNSW / IVF), approx
```

The body walks from the tier blooming insights already lives in up to the tier that needs a real DB.

---

### Tier 0: the in-memory `Map` (where blooming insights already is)

For tens to low-thousands of vectors, store them in a `Map<id, Float32Array>` and answer a query by computing cosine against every entry and sorting. This is exact (it checks all of them) and needs zero new infrastructure. blooming insights already runs this pattern for non-vector data: `McpClient`'s cache `Map` (`lib/mcp/client.ts` L18) and the schema's module-level cache (`lib/mcp/schema.ts` L130).

```
  vectors: Map<id, Float32Array>          (lives in the process, like McpClient.cache)
  query q:
    for each [id, v] in vectors:          ← brute-force scan
        score[id] = cosine(q, v)
    sort by score desc, take top-k
```

The cost is O(N·d) per query — N vectors times d dimensions. At N=80, d=1536 that is ~123k multiply-adds: instant. This tier is correct and you should resist leaving it.

### Tier 1: persistence (JSON file / SQLite)

The `Map` dies on process restart and on a serverless cold start (the exact limitation called out for `McpClient`'s cache). To survive restarts you persist the vectors — a JSON file (like `lib/state/demo-investigations.json`) or SQLite with a vector extension (`sqlite-vss`, `sqlite-vec`). Storage survives; the query is still a brute-force scan loaded into memory.

```
  STATE LAYER (like lib/state/investigations.ts file-cache pattern)
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

Nearest-neighbor is a `for` loop until the `for` loop is too slow, and the entire vector-database industry exists to replace that loop with an approximate index once it is. The corollary is the one engineers most often miss: at small scale you do not need a vector database, you need the `Map` you already have — the same judgment `McpClient` made by caching in memory instead of standing up Redis.

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
│          (McpClient.cache L18, schema cache L130)                   │
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

## In this codebase

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

## Tradeoffs

### In-memory `Map` scan (current tier) vs. SQLite/pgvector vs. dedicated vector DB

| Dimension | Tier 0: `Map` scan | Tier 1: SQLite/pgvector | Tier 3: vector DB |
|---|---|---|---|
| Setup cost | Zero — already used | Low — one extension | High — provision + operate |
| Exactness | Exact (scans all) | Exact or indexed | Approximate (ANN) |
| Survives restart | No | Yes | Yes |
| Scales past 1M | No | Limited | Yes |
| Metadata filtering | Manual | SQL `WHERE` | Native |
| Right when | <1k vectors | <1M, already on SQL | Millions, multi-tenant |

**What we gave up (by not having it).** Nothing today — there are no vectors. When the "search past investigations" feature ships, starting at Tier 0/1 (a `Map` or JSON file scanned exhaustively) gives up nothing at the expected scale (dozens to hundreds of investigations) and avoids operating a vector DB for a `for` loop's worth of data.

**What the alternative would have cost.** Reaching straight for a managed vector DB to store ~100 investigation chunks costs provisioning, a network hop per query (slower than an in-memory scan), a monthly bill, and an operational dependency — all for data that fits in memory and scans in microseconds. It is the Redis-for-a-`Map` mistake the codebase already declined to make for its cache.

**The breakpoint.** The in-memory/JSON tier is correct until either the vectors no longer fit in memory or the brute-force scan exceeds the request latency budget — concretely, past roughly 10⁵–10⁶ vectors, or when cold-start re-loading becomes the dominant latency. At that point an ANN index (Tier 2) or a vector DB (Tier 3) is the required upgrade.

---

## Tech reference (industry pairing)

### in-memory vector store

- **Codebase uses:** the analog tier — `McpClient.cache` `Map` (`lib/mcp/client.ts` L18) and `schema.ts` module cache (L130); no vectors yet.
- **Why it's here (absent for vectors):** the storage tier a <1k-vector index uses; the codebase already lives in it for non-vector data.
- **Leading today:** a plain `Map`/array with brute-force cosine leads for small in-process retrieval (2026).
- **Why it leads:** exact, zero dependencies, microseconds at small N — no reason to add infrastructure.
- **Runner-up:** `hnswlib-node` — an in-process ANN index when N grows but you still want no external service.

### embedded / SQL vector store

- **Codebase uses:** nothing — investigations persist as plain JSON (`lib/state/demo-investigations.json`).
- **Why it's here (absent):** no vectors to persist; the JSON-file pattern is the tier-1 storage shape already in use.
- **Leading today:** pgvector (Postgres) leads by adoption; `sqlite-vec` leads for embedded/local (2026).
- **Why it leads:** vectors live in the database you already run — one store, transactional, SQL metadata filtering.
- **Runner-up:** Chroma — a lightweight embedded vector DB with a simple Python/JS API for prototypes.

### dedicated vector database

- **Codebase uses:** nothing.
- **Why it's here (absent):** scale and operational needs do not justify a separate service.
- **Leading today:** Pinecone leads managed adoption; Qdrant and Weaviate lead open-source/self-host (2026).
- **Why it leads:** ANN index plus persistence, horizontal scaling, metadata filtering, and hybrid scoring in one service.
- **Runner-up:** Milvus — high-scale, GPU-accelerated ANN for very large indexes.

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

## Summary

A vector database stores embeddings and answers nearest-neighbor queries — by brute-force scan at small scale and by an approximate index (HNSW/IVF) once the scan is too slow. blooming insights stores no vectors, but it already runs the small-scale storage tier a vector index would use: an in-memory `Map` (`McpClient.cache`, the schema cache) and JSON-file persistence for investigations. That is the "in-memory/JSON, <1k items, brute-force scan" tier where a vector DB is unnecessary, and the discipline of staying there until the scan runs out is the same one the codebase already applied by choosing a `Map` over Redis for its cache.

**Key points:**
- Nearest-neighbor is a `for` loop until the loop is too slow; vector DBs replace it with an approximate index.
- blooming insights already lives in Tier 0 — a `Map` and JSON files — the tier that needs no vector DB.
- ANN indexes (HNSW/IVF) trade exactness for sub-linear speed; you measure the trade as recall@k.
- In-memory indexes die on cold start, the same limitation `McpClient`'s cache has.
- Climb the storage tiers only when the current one runs out — reaching for a vector DB first is over-engineering.

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

## Validate

### Level 1 — Reconstruct

From memory, draw the four storage tiers (in-memory `Map`, JSON/SQLite, ANN index, vector DB) and state the nearest-neighbor method and scale threshold for each.

### Level 2 — Explain

Out loud: why is brute-force nearest-neighbor exact but eventually too slow? Why does an ANN index give up exactness, and how do you measure what you gave up?

### Level 3 — Apply

Scenario: you are storing embedded past-investigation chunks. Open `lib/mcp/client.ts` L18 (`McpClient.cache` `Map`) and `lib/state/investigations.ts` (the JSON-file persistence pattern). Name which tier you would start in, why a vector DB is unwarranted at ~100 investigations, and the concrete signal (scale or latency) that would justify climbing a tier.

### Level 4 — Defend

A colleague wants to provision a managed vector DB for the "search past investigations" feature on day one. Argue the cost (provisioning, a network hop per query slower than an in-memory scan, a monthly bill) against the data size, and propose the `Map`/JSON tier the codebase already uses for its cache. Then name the threshold at which they would be right.

### Quick check — code reference test

What storage tier does blooming insights already run that a small vector index would reuse, and where? (Answer: the in-memory `Map` tier — `McpClient.cache` at `lib/mcp/client.ts` L18 and the module-level schema cache at `lib/mcp/schema.ts` L130, plus JSON-file persistence in `lib/state/investigations.ts` — the "<1k items, brute-force scan" tier where no vector DB is needed.)

# 03 — Retrieval and RAG

> **This entire sub-section is Case B.** blooming insights has **no embeddings, no vector store, and no RAG**. It retrieves **live** via MCP tool calls + EQL against Bloomreach (a fresh live API, not a static document corpus) — a deliberate "no RAG until a feature provably needs it" decision. Each file is full study material (the concept is real interview knowledge); only `## In this codebase` is short (the honest absence + its analog), and `## Project exercises` is the substantive buildable target.
>
> **Read [11-rag.md](11-rag.md) FIRST.** It is the design-rationale file: it contrasts live-tool retrieval with embedding-RAG, defends blooming insights' choice (the data is a fresh, exact, queryable API where an index would be stale and lossy), and states the threshold rule that the other eleven files inherit — add an embedding retriever only when a feature provably needs fuzzy or relationship recall over non-API data.

## Why Case B is the whole point

The codebase already does retrieval-augmented generation — it grounds every diagnosis in retrieved context. It just uses a **live tool** as the retriever (`execute_analytics_eql`) instead of an **embedding index**. Files 01–10 describe the embedding-index road the codebase deliberately did not take; 11 explains why; 12 describes the graph road that is the cheapest one worth taking. The honest analogs that ground each absence:

- **TTL cache as the freshness analog** — `McpClient`'s 60s `expiresAt` + no-cache-on-error (`lib/mcp/client.ts`) is exactly the staleness mechanism an embedding index needs (`embedding_stale_at` ↔ `expiresAt`). See **09**.
- **`schemaSummary` as crude chunking** — rank-truncation (top-20 events) that drops the long tail (`lib/agents/monitoring.ts`). See **03**.
- **In-memory `Map` + JSON as the storage tier** — the "<1k items, brute-force scan" tier where no vector DB is needed (`lib/mcp/client.ts`, `lib/state/`). See **04**.
- **EQL as sparse/keyword retrieval** — exact structured querying, the sparse end of the spectrum, correct for exact analytics (`lib/mcp/tools.ts`). See **05**.
- **`classifyIntent` as query understanding** — classify + translate-to-EQL, the sibling of query rewriting (`lib/agents/intent.ts`). See **08**.
- **`saveInvestigation` as keyed upsert** — the incremental-indexing shape, minus change-detection (`lib/state/investigations.ts`). See **10**.
- **`bootstrapSchema` walking a graph-shaped schema** — events → properties → catalogs, already traversed (`lib/mcp/schema.ts`); `Insight.metric`/`scope` are edges. See **12**.

## Index

- **[01-embeddings.md](01-embeddings.md)** — A string → fixed float array where closeness encodes meaning; the inverse of a hash (similar inputs → *nearby* outputs). Cosine similarity. Analog: `parseIntent`'s substring matching is what embeddings replace. (C2.1 · B2A.1/B2A.6)
- **[02-embedding-model-choice.md](02-embedding-model-choice.md)** — Three traded knobs: dimension (paid forever per cosine), cost, domain fit measured on *your* data. Analog: the haiku-vs-sonnet model-tiering the codebase already does. (C2.2 · B2A.3)
- **[03-chunking-strategies.md](03-chunking-strategies.md)** — The chunk is the atomic retrievable unit; the boundary is the search resolution. Analog: `schemaSummary` is rank-truncation "chunking" that drops the long tail. (C2.3 · B2A.5)
- **[04-vector-databases.md](04-vector-databases.md)** — Nearest-neighbor is a `for` loop until it's too slow; then ANN. Analog: the in-memory `Map` + JSON is the "<1k items" tier where no vector DB is warranted. (C2.7 · B2A.1/B2A.2)
- **[05-dense-vs-sparse.md](05-dense-vs-sparse.md)** — Exact terms vs. meaning; mirror-image failure modes. Analog: EQL is pure sparse/structured retrieval — and *correct* for exact analytics. (C2.4 · B2A.6/B2A.10)
- **[06-hybrid-retrieval-rrf.md](06-hybrid-retrieval-rrf.md)** — Run dense + sparse, fuse by *rank position* (RRF, `Σ 1/(k+rank)`, k=60) to dodge the cosine-vs-BM25 scale mismatch. Only the sparse leg exists today. (C2.5 · B2A.10)
- **[07-reranking.md](07-reranking.md)** — Retrieve broad (recall, bi-encoder) → rerank narrow (precision, cross-encoder) → place at a high-attention prompt slot. Cross-links **../02-context-and-prompts/02-lost-in-the-middle.md**. (C2.6 · B2A.11)
- **[08-query-rewriting-hyde.md](08-query-rewriting-hyde.md)** — Reshape the query before retrieving: expand, decompose, or HyDE (embed a hypothetical *answer*). Analog: `classifyIntent` + EQL translation is query-understanding-adjacent. (C2.8 · B2B.5)
- **[09-stale-embeddings.md](09-stale-embeddings.md)** — An embedding is a cached snapshot; staleness is silent. Analog: the 60s TTL + no-cache-on-error in `client.ts` IS the freshness mechanism — `embedding_stale_at` ↔ `expiresAt`. (C2.11 · B2A.2/B2A.4)
- **[10-incremental-indexing.md](10-incremental-indexing.md)** — Maintain the index in place — upsert/delete by id, change-detection, don't forget delete (ghosts). Analog: `saveInvestigation`'s `mem.set(insightId, …)` keyed upsert. (C2.12 · B2A.4/B2B.1)
- **[11-rag.md](11-rag.md)** — **THE key file, read first.** RAG = retrieve-then-generate with a *pluggable* retriever; blooming insights chose the live-tool retriever over an embedding index because the data is a fresh, exact, queryable API. Defends the no-RAG decision and the threshold rule. Cross-links **../04-agents-and-tool-use/02-tool-calling.md**. (C2.1 pipeline)
- **[12-graphrag.md](12-graphrag.md)** — Retrieve by traversing relationships ("connected to") not just similarity ("similar to"). Analog: the schema is graph-shaped and `bootstrapSchema` walks it. The "related insights" graph over shared `metric`/`scope` needs **no embeddings** — the cheapest threshold-crossing feature. (C2.13 · B2A.8)

## Reading order

1. **[11-rag.md](11-rag.md)** — the design rationale; why this whole section is the road not taken.
2. **[05-dense-vs-sparse.md](05-dense-vs-sparse.md)** — the retrieval spectrum, and where live EQL sits (sparse, exact, correct).
3. **[01](01-embeddings.md) → [02](02-embedding-model-choice.md) → [03](03-chunking-strategies.md) → [04](04-vector-databases.md)** — the embedding-index building blocks (the mechanics of the road not taken).
4. **[06](06-hybrid-retrieval-rrf.md) → [07](07-reranking.md) → [08](08-query-rewriting-hyde.md)** — making retrieval better (fuse, rerank, rewrite the query).
5. **[09](09-stale-embeddings.md) → [10](10-incremental-indexing.md)** — keeping an index correct over time (the freshness/maintenance burden live retrieval avoids).
6. **[12-graphrag.md](12-graphrag.md)** — the graph road, and the cheapest feature worth building ("related insights").

The buildable target across the section is one coherent feature stack — **semantic search and "related insights" over past investigations** (`lib/state/investigations.ts`) — the single class of feature whose data is *not* a live exact API and therefore the only thing that would justify embedding-RAG or GraphRAG here. Every `## Project exercises` block targets blooming insights paths and builds toward it.

All citations are to blooming insights files (verified line numbers) and curriculum concept/build IDs for provenance only.

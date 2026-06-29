# 03 — Retrieval and RAG

This codebase has **no vector store, no embeddings, no semantic similarity, no chunking, no reranking**. The base spec's retrieval-and-RAG section walks 12 concepts; here, most come back honestly as `not yet exercised`. Two patterns are actually in the code and earn deeper walks:

  → **`01-schema-as-retrieval.md`** — the workspace schema IS the corpus the monitoring agent retrieves from. `bootstrapSchema()` walks the Bloomreach orchestrator once and caches the shape.
  → **`02-schema-gated-coverage.md`** — the 10-category checklist is filtered by what the workspace can actually support. The agent never gets a category it can't run.

The other ten concepts (embeddings, embedding model choice, chunking, vector DBs, dense vs sparse, hybrid RRF, reranking, query rewriting/HyDE, stale embeddings, incremental indexing, RAG, GraphRAG) are honestly treated in one consolidated file:

  → **`03-rag-concepts-not-yet-exercised.md`** — names each concept, explains what it would look like here, names the gap.

## Reading order

1. `01-schema-as-retrieval.md` — the retrieval pattern that exists
2. `02-schema-gated-coverage.md` — the gating pattern that sits on top of it
3. `03-rag-concepts-not-yet-exercised.md` — the honest gap inventory

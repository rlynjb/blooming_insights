# 03 · Retrieval and RAG

**Honest state:** blooming_insights does not currently exercise retrieval. There is no vector store, no embedding pipeline, no chunker, no reranker. The agents work over a live workspace via MCP tools; the workspace schema is small enough to fit in a bounded summary (see `lib/agents/monitoring.ts:19`), so no retrieval has been needed yet.

This sub-section covers the concepts as study material, framed against **where retrieval would fit** in the codebase — three concrete surfaces (past-investigation memory, EQL query library, workspace catalog search). Each concept file follows the same shape: what the pattern is, what its shape is in general, and what the concrete refactor would look like against this codebase's files.

- [01-embeddings.md](01-embeddings.md)
- [02-embedding-model-choice.md](02-embedding-model-choice.md)
- [03-chunking-strategies.md](03-chunking-strategies.md)
- [04-vector-databases.md](04-vector-databases.md)
- [05-dense-vs-sparse.md](05-dense-vs-sparse.md)
- [06-hybrid-retrieval-rrf.md](06-hybrid-retrieval-rrf.md)
- [07-reranking.md](07-reranking.md)
- [08-query-rewriting-hyde.md](08-query-rewriting-hyde.md)
- [09-stale-embeddings.md](09-stale-embeddings.md)
- [10-incremental-indexing.md](10-incremental-indexing.md)
- [11-rag.md](11-rag.md)
- [12-graphrag.md](12-graphrag.md)

## Three concrete surfaces where retrieval would fit

1. **Past-investigation memory** — when the agent investigates a new anomaly that looks like one it has diagnosed before, retrieve the prior diagnosis + evidence + user-accepted recommendation as context. Would live in `lib/state/investigations.ts`.
2. **EQL query library** — as the codebase accumulates working EQL patterns per anomaly type, retrieve the most similar queries as few-shot exemplars before the model composes new ones. Would attach to `lib/agents/monitoring.ts` or a new `lib/eql/library.ts`.
3. **Workspace catalog search** — for ecommerce workspaces with large product catalogs (10k+ items), retrieve top matches for a query like "which products drove the revenue drop" instead of fitting the whole catalog into context. Would live in a new `lib/mcp/catalog-index.ts`.

Each concept file names which of these three (if any) is the load-bearing candidate for the refactor.

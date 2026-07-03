# 03 — Retrieval and RAG

**Mostly not exercised in this codebase.** No embeddings, no vector store, no chunking. The agents query structured event/customer data via MCP tools (`execute_analytics_eql`, `list_customers`), not text over vectors.

This sub-section is generated per spec — the concepts are in scope for the LLM-app-engineering shape, and Case B project exercises describe how RAG would be added if the product grew a corpus (past investigations, comment threads, runbook markdown).

## Files

Each file is on-spec but concise. Case B exercises name the concrete add-RAG-to-this-repo move.

- `01-embeddings.md` — Case B
- `02-embedding-model-choice.md` — Case B
- `03-chunking-strategies.md` — Case B
- `04-vector-databases.md` — Case B
- `05-dense-vs-sparse.md` — Case B
- `06-hybrid-retrieval-rrf.md` — Case B
- `07-reranking.md` — Case B
- `08-query-rewriting-hyde.md` — Case B
- `09-stale-embeddings.md` — Case B
- `10-incremental-indexing.md` — Case B
- `11-rag.md` — Case B (the umbrella pattern)
- `12-graphrag.md` — Case B

## Where retrieval would fit in this codebase

The natural corpus: **past diagnoses and their evidence**, plus **the demo snapshot's investigations**. A "similar past investigations" panel on the investigate page could pull three prior diagnoses with matching metrics/scopes as context for the current one. That's the shape of a RAG add that would earn its place.

## Anchor shape

LLM application engineering — RAG is in scope for the shape even when not currently exercised.

## Curriculum

Phase 2A/2B — concepts C2.1-C2.13.

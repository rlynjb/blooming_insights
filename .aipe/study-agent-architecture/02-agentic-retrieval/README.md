# Section B — Agentic retrieval

**Anchor:** single-agent (primary).
**Cross-references:** `.aipe/study-ai-engineering/03-retrieval-and-rag/` for all retrieval mechanics (embeddings, chunking, vector DBs, dense/sparse, RRF, reranking, RAG, GraphRAG). Not re-taught here.

This sub-section covers the shift from retrieval as a *one-shot pipeline step* to retrieval as a *control loop the agent drives*. Pure agent-architecture concern.

## Honest note on this codebase

blooming_insights does not exercise any of the agentic-retrieval patterns in this sub-section. The DiagnosticAgent's data-gathering is *tool-driven*, not retrieval-driven — `execute_analytics_eql` runs analytical queries against a workspace, not semantic search against a document corpus. There's no vector store, no embedding pipeline, no chunk index.

The reason to still cover these patterns: (a) they're the standard escalation path if the product grew to include unstructured data (playbooks, historical incident writeups, Bloomreach docs); (b) recognizing the *shape* of the tool-calling loop as "retrieval as a control loop" is a valid reframe.

## Files

1. **`01-agentic-rag.md`** — the loop version of RAG. Not yet implemented. Where it would land if unstructured knowledge got added.
2. **`02-self-corrective-rag.md`** — relevance grading + fallback. Not yet implemented.
3. **`03-retrieval-routing.md`** — routing across multiple stores. This is the closest to what this repo *would* need — routing between EQL queries, catalog lookups, and (hypothetically) doc retrieval.

## Reading order

Read `01-agentic-rag.md` first for the loop shape; the others are refinements of the same loop.

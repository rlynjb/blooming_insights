# 02 — Agentic retrieval

Anchor: **single-agent** (primary)

Retrieval as a control loop the agent drives, not as a one-shot pipeline step. This is the shift from static RAG to a loop that decomposes queries, evaluates results, and re-retrieves.

**This section does not re-teach retrieval mechanics.** Embeddings, chunking, vector stores, dense/sparse retrieval, RRF, reranking, RAG basics, GraphRAG — all covered in `.aipe/study-ai-engineering/03-retrieval-and-rag/`. This section is purely about the *control loop* around retrieval, which is an agent-architecture concern.

**Important framing for this repo.** blooming insights does not do vector retrieval. It does *tool-driven retrieval* — the agent picks which EQL query (via the MCP `execute_analytics_eql` tool) to run, and every answer is grounded in the returned rows. There is no vector store, no embedding, no reranker. The three concepts in this section still apply: agentic RAG maps onto "the agent picks its next EQL based on what the last one returned," self-corrective RAG maps onto "if the EQL returned garbage, rewrite it and retry," retrieval routing maps onto "which MCP tool for this question — analytics EQL vs segment definitions vs catalog lookup."

## Reading order

1. **[01-agentic-rag.md](./01-agentic-rag.md)** — retrieval as a loop, and how tool-driven retrieval is the same pattern.
2. **[02-self-corrective-rag.md](./02-self-corrective-rag.md)** — grading retrieved chunks (or query results) before generation.
3. **[03-retrieval-routing.md](./03-retrieval-routing.md)** — routing to the right knowledge source; in this repo, the right MCP tool.

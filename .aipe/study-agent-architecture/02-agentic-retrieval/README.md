# 02 · Agentic retrieval

How a model uses retrieval as a control loop rather than a one-shot pipeline step.

**None of the patterns in this sub-section are in this repo.** This codebase does not use RAG. It has no embeddings, no vector store, no chunking, no similarity search. Retrieval is via MCP tool calls (Bloomreach EQL) — the model writes a query, the harness runs it, the result comes back as a `tool_result` block. That's tool-use, not retrieval.

These files are included for completeness and to make the "where would RAG go" question answerable. Each one names what would change in this repo to adopt the pattern.

## Files

1. [`01-agentic-rag.md`](./01-agentic-rag.md) — ReAct whose primary tool is retrieval
2. [`02-self-corrective-rag.md`](./02-self-corrective-rag.md) — grade retrieved chunks before generating
3. [`03-retrieval-routing.md`](./03-retrieval-routing.md) — pick the source before retrieving

## How this maps to the codebase

| File | In this codebase? |
|---|---|
| Agentic RAG | **No** — retrieval is via MCP tools, not embeddings. The agent loop drives tool calls; "agentic RAG" would mean the tools were similarity-search backed. |
| Self-corrective RAG | **No** — there's no retrieved-chunk grading step because there are no retrieved chunks. |
| Retrieval routing | **Partial** — the URL router + intent classifier already do *tool routing* (`07-routing.md`). Real retrieval routing would mean picking between, say, Bloomreach EQL vs a vector store vs live web search — none of which exist here. |

## Cross-reference

For retrieval mechanics in general (embeddings, chunking, vector DBs, dense/sparse, RRF, reranking, classic RAG, GraphRAG), see ai-engineering's `03-retrieval-and-rag/` if generated. This sub-section assumes you know those mechanics and covers only the *control loop* angle — retrieval driven by an agent.

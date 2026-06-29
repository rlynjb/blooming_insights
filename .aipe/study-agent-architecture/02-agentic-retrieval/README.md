# 02 — Agentic retrieval

Anchor: single-agent (primary)

Retrieval-as-a-control-loop. This sub-section does **not** re-teach retrieval mechanics — those would live in `study-ai-engineering`'s `03-retrieval-and-rag/`. What lives here is the shift from retrieval as a one-shot pipeline step to retrieval as a loop the agent drives.

## How this maps to the repo

This repo does **agentic data-retrieval** but **not vector RAG**. There's no embedding index, no chunking, no vector DB. The agents drive their own EQL queries against Bloomreach via MCP — the *mechanic* is agentic (the model picks each query, observes the result, decides whether to query again), the *substrate* is structured-data retrieval over a tool-calling MCP server, not vector retrieval over embedded documents.

This distinction matters because the canonical agentic RAG vocabulary (re-ranker, BM25 + dense fusion, RRF, semantic cache) doesn't apply here — but the *control loop* part does. The files below cover the control loop and call the vector-store mechanics out as "not in this repo, lives in `study-ai-engineering` when generated."

## Reading order

1. `01-agentic-rag.md` — the loop shape, applied to this repo's MCP retrieval
2. `02-self-corrective-rag.md` — the grader pattern; not in this repo
3. `03-retrieval-routing.md` — picking the right source; this repo has one source so the pattern is at the tool-allowlist level

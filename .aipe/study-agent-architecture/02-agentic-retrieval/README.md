# 02 — Agentic retrieval

How retrieval stops being a one-shot pipeline step and starts being a loop the agent drives. Three files, intentionally a thin sub-section in this codebase — because blooming insights does live-tool retrieval (`execute_analytics_eql` against Bloomreach via MCP) rather than the textbook embedding-index RAG. The agentic-RAG loop is real here; the rest of the embedding-RAG mechanics (chunking, vector stores, dense/sparse, reranking) live in the AI engineering guide and are cited rather than re-taught.

> If you're looking for *why no embedding-RAG*, that's covered in detail in `../../study-ai-engineering/03-retrieval-and-rag/11-rag.md` — read that first if you're trying to understand the choice. This sub-section covers the *agent-architecture angle*: retrieval as a control loop, the relevance gate that isn't here, and routing between sources when there's more than one.

## Reading order

| # | File | What it covers | Case |
|---|------|----------------|------|
| 1 | [01-agentic-rag.md](01-agentic-rag.md) | Retrieval as a tool the model calls inside a ReAct loop; the model writes the query sequence at runtime. The retriever is an interface — vector index, SQL, web, or live API all fill the slot. This codebase fills it with `execute_analytics_eql` against Bloomreach. | A (live agentic retrieval) |
| 2 | [02-self-corrective-rag.md](02-self-corrective-rag.md) | A relevance/groundedness grader between retrieve and generate, with a fallback ladder (rewrite, widen, escalate). Not implemented on the retrieval path here; two adjacent checks live in the prompts — the monitoring volume-check (premise side) and the diagnostic hypothesis-test (answer side). | B (not yet implemented) |
| 3 | [03-retrieval-routing.md](03-retrieval-routing.md) | Routing a query to the right knowledge source before retrieving. One source here (Bloomreach MCP), so source routing doesn't apply; the capability gate in `lib/agents/categories.ts` is the adjacent pattern — pre-retrieval *capability* routing rather than source routing. | B (mostly — source routing absent; capability gate adjacent) |

## Why this sub-section is thin

This codebase makes a deliberate retrieval choice: live tool calls instead of an embedding index. That choice is the load-bearing decision the AI engineering guide walks (`../../study-ai-engineering/03-retrieval-and-rag/11-rag.md` covers the threshold rule end-to-end). Everything downstream of that choice — chunking, embedding model selection, vector DB choice, dense/sparse split, hybrid retrieval, reranking, query rewriting/HyDE, stale-embedding handling, incremental indexing — is moot here, because the snapshot the embeddings would index doesn't exist.

What *does* matter, and what this sub-section covers, is the agent-architecture surface of retrieval:

- **The control loop.** Static RAG fixes the retrieval plan in code; agentic RAG hands it to the model. blooming insights is the agentic shape with a live API as the retriever (`01`).
- **The validity gate.** Retrieval-success is not answer-success; a relevance grader is the gate between them. Not in this codebase, with honest naming of the adjacent checks that are (`02`).
- **The dispatch layer.** Multiple sources need a router before retrieval. One source here, so the source router doesn't apply — the capability gate in `lib/agents/categories.ts` is what's here instead, and it routes the question space at the capability layer rather than the source layer (`03`).

## Cross-references

- `../../study-ai-engineering/03-retrieval-and-rag/11-rag.md` — why no embedding-RAG; the live-tool-vs-vector-index decision, walked
- `../../study-ai-engineering/04-agents-and-tool-use/07-capability-gating.md` — the broader capability-gating pattern the coverage gate instantiates
- `../01-reasoning-patterns/02-react.md` — the ReAct loop shape agentic RAG sits on
- `../01-reasoning-patterns/06-routing.md` — routing as a single-agent pattern (this file's sibling at the reasoning layer)
- `../01-reasoning-patterns/04-reflexion-self-critique.md` — self-critique as a loop on the answer, not on retrieval

---
Updated: 2026-05-29 — created

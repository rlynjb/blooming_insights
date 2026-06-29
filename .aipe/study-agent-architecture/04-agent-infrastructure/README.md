# 04 — Agent infrastructure

Anchor: single-agent + multi-agent (both)

The cross-cutting disciplines that matter more than any single topology. These are the parts that separate a demo from a shipped agent system.

This sub-section is **deeply exercised** in the repo. Every file below has a live anchor in the code.

## Reading order

1. `01-context-engineering.md` — the discipline RAG and prompt engineering are subsets of. The `schemaSummary` token-budget trick is the load-bearing example.
2. `02-agent-memory-tiers.md` — working/episodic/long-term. This repo runs working memory only.
3. `03-tool-calling-and-mcp.md` — the connective tissue under every pattern. The full MCP wire path.
4. `04-agent-evaluation.md` — the Vitest-with-injected-fakes pattern; 144 tests; trajectory eval surface.
5. `05-guardrails-and-control.md` — the control envelope. The strongest infrastructure piece in this repo.

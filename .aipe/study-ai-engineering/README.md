# blooming insights — AI engineering study guide

A topic-focused companion to [`study-system-design/`](../study-system-design/README.md). Same staff-engineer voice, same per-concept template — but the lens is **AI engineering**: LLM foundations, retrieval, agents, evals, and production serving, anchored to blooming insights' real code.

## Codebase shape: LLM application engineering

blooming insights is the **LLM application engineering** shape — four single-purpose agents share one Claude tool-use loop, call read-only tools through a `DataSource` seam (Bloomreach MCP in prod, an authored SQLite-backed MCP server in eval/local), extract a validated structured artifact from the model's prose, and stream the reasoning trace to the UI. **Phase 3 added a real 4-pillar eval suite** (detection / diagnosis / recommendation / regression — `eval/scripts/`, ~75 files) with LLM-as-judge rubrics under `eval/judges/` and dated result paper trails under `eval/results/2026-06-15*/`. Test count is now **269** (up from 144 pre-Phase-3). It still has **no machine-learning surface** (no trained models, recommenders, or on-device inference), so the ML sub-sections (`08-machine-learning/`, `09-ml-system-design-templates/`) and `ml-features-in-this-codebase.md` are not generated.

Start with [`00-overview.md`](00-overview.md) for the system map, then [`ai-features-in-this-codebase.md`](ai-features-in-this-codebase.md) for the feature-by-feature breakdown.

## Sub-sections

- **[01-llm-foundations/](01-llm-foundations/README.md)** (9 files) — what an LLM is, tokenization, sampling parameters, structured outputs, streaming, token economics, heuristic-before-LLM, provider abstraction, user-override locks.
- **[02-context-and-prompts/](02-context-and-prompts/README.md)** (3 files) — context window, lost-in-the-middle, prompt chaining.
- **[03-retrieval-and-rag/](03-retrieval-and-rag/README.md)** (12 files) — embeddings, model choice, chunking, vector DBs, dense vs sparse, hybrid/RRF, reranking, query rewriting/HyDE, stale embeddings, incremental indexing, RAG, GraphRAG.
- **[04-agents-and-tool-use/](04-agents-and-tool-use/README.md)** (8 files) — agents vs chains, tool calling, ReAct, tool routing, agent memory, error recovery, capability gating (the schema gate), authoring your own MCP server (domain tools vs raw EQL).
- **[05-evals-and-observability/](05-evals-and-observability/README.md)** (5 files) — eval set types, eval methods, LLM-as-judge bias (with calibration receipts), LLM observability, regression evals (capture + structural-diff + similarity-judge two-mode scoring).
- **[06-production-serving/](06-production-serving/README.md)** (5 files) — LLM caching, cost optimization, prompt injection, rate limiting + backpressure, retry + circuit breaker.
- **[07-system-design-templates/](07-system-design-templates/README.md)** (3 files) — IK interview reframes: search ranking, tech-support chatbot, the multi-rubric eval pipeline (the 4-pillar suite this codebase shipped).

## Reading order

No file requires another — each is self-contained with "See also" cross-links. But the path that tracks the codebase's strengths:

1. **`04-agents-and-tool-use/`** first — the agent loop is the heart of the system, and the richest, most Case-A sub-section.
2. **`01-llm-foundations/04-structured-outputs.md` and `05-streaming.md`** — the two foundation concepts this codebase exercises hardest.
3. **`05-evals-and-observability/04-llm-observability.md`** — the trace-as-product, another genuine strength.
4. **`06-production-serving/`** — what's hardened (caching, rate-limiting, retry) and what isn't (injection, circuit breaker).
5. **`03-retrieval-and-rag/11-rag.md`** — read this to understand *why* there is no RAG, then the rest of `03-` as study material.

## Case A vs Case B

**Case A** (implemented — cited to real `file:line`): the agent loop and all four agents, tool calling, ReAct, tool routing, **capability gating (the anomaly-coverage schema gate)**, the **DataSource adapter seam** (Bloomreach ↔ Olist authored MCP server, switched by `bi:mode`), **authoring an MCP server** (the sibling `mcp-server-olist/` package with three domain tools — `get_metric_timeseries` / `get_segments` / `get_anomaly_context` — instead of raw EQL), **prompt anchoring** (DATA HORIZON + 3-dim scan plan in `lib/agents/prompts/monitoring.md`), structured outputs, streaming, heuristic-before-LLM, the provider/transport seam, context budgeting, prompt chaining, LLM observability, **the 4-pillar eval suite** (detection / diagnosis / recommendation / regression — `eval/scripts/`), **LLM-as-judge with calibration receipts** (`eval/judges/`, manual-vs-judge agreement spot-checks), **regression eval with structural diff + similarity judge** two-mode scoring, exact-match caching, model-routing cost control, inter-call rate limiting, bounded retry.

**Case B** (not yet implemented — full study material + a blooming-insights-targeted buildable exercise): all of `03-retrieval-and-rag/` (the codebase chose live tool-retrieval over embedding-RAG), prompt-injection hardening on `?q=`, the circuit breaker, user-override locks, cross-family judging (the current diagnosis/recommendation judges use the same `claude-sonnet-4-6` family as the agents — the self-preference trap is partially deferred even with calibration receipts in hand). Case-B exercises cite curriculum Build IDs for provenance but target real blooming insights paths.

> Curriculum-loaded: each concept file carries a `## Project exercises` block mapping to `aieng-curriculum.md` concept/build IDs. The curriculum is a concept index only — every exercise targets blooming insights' own files.

---
Updated: 2026-05-29 — added `04-agents-and-tool-use/07-capability-gating.md` (the anomaly-coverage schema gate); bumped the 04 sub-section count (6→7) and listed capability gating under Case A.
Updated: 2026-06-16 — Phase 2 (DataSource seam + authored Olist MCP server) and Phase 3 (4-pillar eval suite + LLM-as-judge with calibration receipts + regression eval) flipped from Case B to Case A: 04 sub-section count 7→8 (added authoring-mcp-server), 05 4→5 (added regression-evals + flipped Case B → Case A on evals), 07 2→3 (added the multi-rubric eval pipeline template); test count 144→269.

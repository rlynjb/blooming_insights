# blooming insights — AI engineering study guide

A topic-focused companion to [`study-system-design/`](../study-system-design/README.md). Same staff-engineer voice, same per-concept template — but the lens is **AI engineering**: LLM foundations, retrieval, agents, evals, and production serving, anchored to blooming insights' real code.

## Codebase shape: LLM application engineering

blooming insights is the **LLM application engineering** shape — five single-purpose agents (monitoring / diagnostic / recommendation / query / intent) come from `@aptkit/core@0.3.0`, are wired together by **three Blooming-owned adapters** (`lib/agents/aptkit-adapters.ts` — Anthropic ModelProvider, DataSource ToolRegistry, NDJSON TraceSink), call read-only tools through a `DataSource` seam (Bloomreach MCP in prod; a Blooming-owned `SyntheticDataSource` for local/test), extract validated structured artifacts via AptKit's per-agent output validators, and stream the reasoning trace to the UI. The Phase-3 eval suite under `eval/` was removed in PR #8 (commit 62c24d7) — no 4-pillar harness, no judges, no portfolio numbers. Test count is **221** (down from 269 with the eval/ removal, up from 144 pre-AptKit). It has **no machine-learning surface** (no trained models, recommenders, or on-device inference), so the ML sub-sections (`08-machine-learning/`, `09-ml-system-design-templates/`) and `ml-features-in-this-codebase.md` are not generated.

Start with [`00-overview.md`](00-overview.md) for the system map, then [`ai-features-in-this-codebase.md`](ai-features-in-this-codebase.md) for the feature-by-feature breakdown.

## Sub-sections

- **[01-llm-foundations/](01-llm-foundations/README.md)** (9 files) — what an LLM is, tokenization, sampling parameters, structured outputs, streaming, token economics, heuristic-before-LLM, provider abstraction, user-override locks.
- **[02-context-and-prompts/](02-context-and-prompts/README.md)** (3 files) — context window, lost-in-the-middle, prompt chaining.
- **[03-retrieval-and-rag/](03-retrieval-and-rag/README.md)** (12 files) — embeddings, model choice, chunking, vector DBs, dense vs sparse, hybrid/RRF, reranking, query rewriting/HyDE, stale embeddings, incremental indexing, RAG, GraphRAG.
- **[04-agents-and-tool-use/](04-agents-and-tool-use/README.md)** (9 files) — agents vs chains, tool calling, ReAct, tool routing, agent memory, error recovery, capability gating (the schema gate), authoring your own MCP server (RETIRED — file kept as a banner; mcp-server-olist gone), **AptKit primitive adapters** (the new senior-level pattern: own your domain glue + use an upstream library's generic primitives — `lib/agents/aptkit-adapters.ts`).
- **[05-evals-and-observability/](05-evals-and-observability/README.md)** (5 files) — eval set types, eval methods, LLM-as-judge bias, LLM observability, regression evals (RETIRED — file kept as a banner; eval suite gone). Evals are back to Case B (study material only); observability remains Case A (the trace is the product).
- **[06-production-serving/](06-production-serving/README.md)** (5 files) — LLM caching, cost optimization, prompt injection, rate limiting + backpressure, retry + circuit breaker.
- **[07-system-design-templates/](07-system-design-templates/README.md)** (3 files) — IK interview reframes: search ranking, tech-support chatbot, the multi-rubric eval pipeline (RETIRED — file kept as a banner; the 4-pillar eval suite that was the worked example is gone).

## Reading order

No file requires another — each is self-contained with "See also" cross-links. But the path that tracks the codebase's strengths:

1. **`04-agents-and-tool-use/09-aptkit-primitive-adapters.md`** first — the new senior-level pattern (own your domain adapters + use a library's generic primitives) is the highest-signal addition in this refresh.
2. **`04-agents-and-tool-use/01–07`** — the agent loop is the heart of the system, now expressed via AptKit primitives; the patterns still apply.
3. **`01-llm-foundations/04-structured-outputs.md` and `05-streaming.md`** — the two foundation concepts this codebase exercises hardest.
4. **`05-evals-and-observability/04-llm-observability.md`** — the trace-as-product, the remaining Case-A half of 05.
5. **`06-production-serving/`** — what's hardened (caching, rate-limiting, retry) and what isn't (injection, circuit breaker).
6. **`03-retrieval-and-rag/11-rag.md`** — read this to understand *why* there is no RAG, then the rest of `03-` as study material.

## Case A vs Case B

**Case A** (implemented — cited to real `file:line`): the agent loop and all five agents (now from `@aptkit/core`), tool calling, ReAct, tool routing, **capability gating (the anomaly-coverage schema gate)**, the **DataSource adapter seam** (Bloomreach ↔ a Blooming-owned in-process `SyntheticDataSource`, switched by `bi:mode`), the **AptKit primitive adapters** (`lib/agents/aptkit-adapters.ts` — Anthropic ModelProvider, DataSource ToolRegistry, NDJSON TraceSink), structured outputs (via `@aptkit/agent-*` validators; legacy under `lib/agents/legacy-validate.ts`), streaming, heuristic-before-LLM, the provider/transport seam, context budgeting, prompt chaining (active prompts from `@aptkit/prompts`; legacy under `lib/agents/legacy-prompts/`), LLM observability (the NDJSON trace), exact-match caching, model-routing cost control, inter-call rate limiting, bounded retry.

**Case B** (not yet implemented — full study material + a blooming-insights-targeted buildable exercise): all of `03-retrieval-and-rag/` (the codebase chose live tool-retrieval over embedding-RAG), **evals** (the 4-pillar eval suite under `eval/` was removed in PR #8 — no detection / diagnosis / recommendation / regression harness anymore; the framing returns to study-material), prompt-injection hardening on `?q=`, the circuit breaker, user-override locks. Case-B exercises cite curriculum Build IDs for provenance but target real blooming insights paths.

> Curriculum-loaded: each concept file carries a `## Project exercises` block mapping to `aieng-curriculum.md` concept/build IDs. The curriculum is a concept index only — every exercise targets blooming insights' own files.

---
Updated: 2026-05-29 — added `04-agents-and-tool-use/07-capability-gating.md` (the anomaly-coverage schema gate); bumped the 04 sub-section count (6→7) and listed capability gating under Case A.
Updated: 2026-06-16 — Phase 2 (DataSource seam + authored Olist MCP server) and Phase 3 (4-pillar eval suite + LLM-as-judge with calibration receipts + regression eval) flipped from Case B to Case A: 04 sub-section count 7→8 (added authoring-mcp-server), 05 4→5 (added regression-evals + flipped Case B → Case A on evals), 07 2→3 (added the multi-rubric eval pipeline template); test count 144→269.
Updated: 2026-06-19 — Olist removal (PR #8 / 62c24d7) collapsed the eval framing: evals flipped Case A → Case B; `04/08-authoring-mcp-server.md`, `05/05-regression-evals.md`, and `07/03-multi-rubric-eval-pipeline.md` kept as RETIRED-banner files. AptKit integration (`@aptkit/core@0.3.0` + 3 adapter classes in `lib/agents/aptkit-adapters.ts`) added as the new ground; 04 sub-section count 8→9 (added `09-aptkit-primitive-adapters.md`). `SyntheticDataSource` is the new in-process fake under `live-synthetic`; mode names renamed from `live-sql` → `live-synthetic`. Test count 269→221.

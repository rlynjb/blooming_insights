# Study — AI engineering (blooming_insights)

This folder is the per-repo AI-engineering study guide. The codebase shape is **LLM application engineering** — five Anthropic agents orchestrated through a `@aptkit/core@0.3.0` runtime, talking to a Bloomreach Engagement MCP server through a swap-in port (`DataSource`), with NDJSON streaming back to the UI as a first-class surface.

There is no classical ML in this codebase. Sections 8 (Machine Learning) and 9 (ML system design templates) are not generated — every concept here is about driving LLMs in production.

## Reading order

Open in this order — each sub-section leans on the orientation the previous one set.

1. **`00-overview.md`** — one-page map. The whole AI stack in one diagram: ports, adapters, agents, streaming. Read first; skim only this if you have five minutes.
2. **`audit.md`** — the seven-lens audit. One section per AI-engineering lens (LLM call surface, context discipline, retrieval, agent loop, evals + observability, production serving, system-design framings), each with `file:line` evidence or an honest `not yet exercised`.
3. **Sub-section folders (`01-` through `07-`)** — the discipline broken into seven phases of an LLM app's life. Each folder owns one phase and has its own `README.md` that lists the files in reading order.
4. **`ai-features-in-this-codebase.md`** — the actual AI features this repo runs: the five agents, what each one does, which patterns it exercises, what its failure mode looks like.

## Sub-sections

| # | Folder | What it teaches |
|---|--------|-----------------|
| 01 | `01-llm-foundations/` | What the LLM actually is, tokenization, sampling, structured outputs, token economics, the heuristic-before-LLM router, the provider port |
| 02 | `02-context-and-prompts/` | The fixed context window, lost-in-the-middle, prompt chaining (the diagnose → recommend handoff) |
| 03 | `03-retrieval-and-rag/` | The schema-as-retrieval pattern this repo uses instead of vector search, and the gate that decides which categories to run |
| 04 | `04-agents-and-tool-use/` | The five Anthropic agents, the ReAct loop inside `@aptkit/core`, tool calling against the MCP server, intent-based tool routing, error recovery |
| 05 | `05-evals-and-observability/` | LLM observability today (per-call usage logs, per-phase timings, NDJSON traces) and the Phase 3 eval suite that was built and retired |
| 06 | `06-production-serving/` | LLM caching (60s response cache + Anthropic prompt caching), cost via cheap-classifier routing, rate limiting against Bloomreach, retry-with-backoff, prompt-injection surface |
| 07 | `07-system-design-templates/` | Interview reframes — the codebase walked as the IK "search ranking" and "tech support chatbot" templates |

## Cross-links to neighboring guides

- **`study-system-design`** — the *where* lives in that folder (request flow, port + adapters, streaming kernel). This folder is the *AI-engineering view* of the same code: the LLM call surface, the agent loop, the prompt boundary.
- **`study-prompt-engineering`** — the per-prompt anatomy (the four agent prompts at `lib/agents/legacy-prompts/*.md`) lives there. This folder treats prompts as atoms; the prompt-engineering guide cracks them open.
- **`study-data-modeling`** — the shape of `Anomaly` / `Diagnosis` / `Recommendation` (the structured outputs the agents produce) lives there.

## On UPDATE

- Add a concept file under a sub-section when the codebase grows a new AI pattern (e.g. a real RAG surface lands → add it under `03-retrieval-and-rag/`).
- Update a concept file when its implementation changes (e.g. the agent loop swaps `@aptkit/core` for something else → update `04-agents-and-tool-use/`).
- Move a concept to retired-historical framing (not delete) when it was built and removed — the Phase 3 eval suite is the canonical example.
- Regenerate `audit.md` against current evidence on every run.

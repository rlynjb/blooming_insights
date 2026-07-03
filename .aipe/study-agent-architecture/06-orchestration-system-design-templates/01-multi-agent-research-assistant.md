# Multi-agent research assistant

*System design template · fan-out + synthesis*

- **The prompt:** "Design a system that answers a complex research question by gathering from multiple sources and synthesizing."

- **Standard architecture:** supervisor decomposes the question → parallel worker agents each retrieve from a source (agentic RAG per worker) → supervisor synthesizes with citations.

```
                    ┌──── supervisor ────┐
                    │  decompose Q into  │
                    │  sub-questions     │
                    └────┬────┬────┬─────┘
                         ▼    ▼    ▼
                     ┌───┐┌───┐┌───┐
                     │ w │ │ w │ │ w │   parallel workers,
                     │ 1 │ │ 2 │ │ 3 │   one per source
                     └─┬─┘ └─┬─┘ └─┬─┘   (agentic RAG each)
                       │     │     │
                       └─────┼─────┘
                             ▼
                    ┌────────────────┐
                    │  merge agent    │
                    │  synthesizes    │
                    │  with citations │
                    └────────────────┘
```

- **Data model:** source registry (which sources exist, what they contain), per-worker retrieval indices (vector store / relational DB / API), a shared findings store keyed by sub-question, citation provenance (which chunk supported which claim).

- **Key components:** decomposition (supervisor's core job — LLM or heuristic), parallel retrieval workers (fan-out, one per source), synthesis (merge agent — has to handle conflicts and confidence), citation tracking (every claim in the final answer maps to a specific retrieved chunk). Decision per component: tools-style vs handoff-style delegation for the workers; shared state vs message passing for findings.

- **Scale concerns:** at many sources, fan-out cost multiplies (see `05-production-serving/02-fan-out-backpressure.md`); at deep questions, iteration blowup within workers (cap it); at high volume, the supervisor becomes the bottleneck (use cheap models for workers, expensive only for supervisor); at any scale, LLM supervisor cost adds up (code supervisor when the decomposition patterns stabilize).

- **Eval framing:** trajectory eval (did each worker hit the right source? did they use tools well?); answer groundedness (every claim cites a retrieved chunk); cost + latency per question; recovery rate on source failures.

- **Common failure modes:** synthesis of contradictory sources (see `03-multi-agent-orchestration/09-coordination-failure-modes.md`, synthesis failure); citation hallucination (agent asserts a citation that doesn't back the claim); cost blowup from deep loops; lost-in-the-middle across many worker results (the merger has to fit N results in its window).

- **Applies to this codebase:** **partially**. This repo has the supervisor-worker shape (route as supervisor, four workers) but does not fan out — the diagnostic runs sequentially. Retrieval is tool-driven (`execute_analytics_eql`), not vector-based. Citation provenance exists (Diagnosis carries `evidence[]` with raw EQL results). The "research question" here is "why did this metric change" — a genuinely multi-source shape would map cleanly if the workspace exposed multiple heterogeneous sources.

- **How to make it apply:** three concrete changes.

  1. **Fan out diagnostic hypothesis testing.** Split the diagnostic's hypothesis testing into independent workers, one per hypothesis. New files: `lib/agents/hypothesis-worker.ts`, `lib/agents/diagnosis-merger.ts`. Wire via `Promise.allSettled` in a wrapper around the current DiagnosticAgent. Add concurrency cap + shared BudgetTracker + upward backpressure (`05-production-serving/02-fan-out-backpressure.md`). Estimated latency: 50s → 20s.

  2. **Add multiple retrieval sources.** Currently one MCP server (Bloomreach). A research-shape system would route across sources — Bloomreach EQL for analytics, a vector store for docs, live search for market news. Would require: (a) source registry (mapping question type to source), (b) per-source workers, (c) merge agent that handles heterogeneous evidence. The `x-bi-mcp-config` + AuthProvider abstraction (`lib/mcp/config.ts`) already supports pointing at multiple MCP servers per session; the missing piece is *concurrent* multi-source routing.

  3. **Explicit synthesis agent with citation.** Today the DiagnosticAgent's final Diagnosis carries evidence but doesn't cross-reference which piece of evidence supports which specific claim in the conclusion. A synthesis agent could tag each claim in `conclusion` with the specific evidence indices that support it. Small refactor to the Diagnosis schema (`lib/mcp/types.ts`) plus a synthesis pass at the end of the diagnostic loop.

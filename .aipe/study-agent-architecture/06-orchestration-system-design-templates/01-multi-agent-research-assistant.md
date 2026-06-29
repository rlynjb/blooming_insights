# Multi-agent research assistant

A system-design template. Generic structure, applied to this codebase.

- **The prompt:** "Design a system that answers a complex research question by gathering from multiple sources and synthesizing."

- **Standard architecture:** supervisor decomposes the question → parallel worker agents each retrieve from a source (agentic RAG per worker) → supervisor synthesizes with citations.

```
                       ┌─ Supervisor Agent ──────────────────┐
                       │  (decomposes question into sub-      │
                       │   questions; assigns each to a       │
                       │   worker; synthesizes final answer)  │
                       └────────┬────────────┬────────────┬───┘
                                ▼            ▼            ▼
                         ┌──────────┐ ┌──────────┐ ┌──────────┐
                         │worker A   │ │worker B   │ │worker C   │
                         │(vector DB)│ │(SQL/EQL)  │ │(web/MCP)  │
                         │agentic RAG│ │agentic RAG│ │agentic RAG│
                         └─────┬────┘ └─────┬────┘ └─────┬────┘
                               └─────┬──────┴────────────┘
                                     ▼
                            ┌────────────────────┐
                            │ Synthesis Agent    │  reads worker
                            │ (merges findings;  │  outputs + the
                            │  reconciles        │  original
                            │  contradictions;   │  question
                            │  cites sources)    │
                            └────────────────────┘
```

- **Data model:** source registry (which sources exist, with their tools), per-worker retrieval indices (vector store per source if RAG, structured-query handlers if SQL/MCP), a shared findings store keyed by sub-question, citation provenance (each finding tagged with its source + the exact query that produced it).

- **Key components:** decomposition (supervisor), parallel retrieval (workers in fan-out), synthesis (merge agent with conflict-detection in the prompt), citation tracking. Decisions per component: tools-style vs handoff-style delegation (default: tools-style for trace clarity); shared state vs message passing (default: message passing — typed sub-question results, not a shared blackboard).

- **Scale concerns:** at many sources, fan-out cost compounds (model calls × workers × per-worker tool calls). At deep questions, iteration blowup — cap per-worker `maxToolCalls` and add a global per-run budget. At high volume, the supervisor becomes the bottleneck — keep workers on cheap models (Haiku), reserve expensive model (Sonnet) for the supervisor only.

- **Eval framing:** trajectory eval per worker (did it hit the right source? did it issue the right queries?). Answer groundedness — every claim in the final synthesis must cite a retrieved chunk or query result. Cost/latency per question, tracked separately for the supervisor vs aggregated workers.

- **Common failure modes:** synthesis of contradictory sources (worker A says X, worker B says ~X — supervisor averages instead of surfacing conflict). Citation hallucination (synthesizer references a chunk that wasn't in the worker results). Cost blowup from deep loops (a sub-question that triggers many sub-sub-queries). Lost-in-the-middle across many worker results (with N workers each returning 5 chunks, the supervisor's context grows fast).

- **Applies to this codebase:** **partially.** The investigation pipeline does *decompose → retrieve → analyze* — the diagnostic agent's ReAct loop decomposes the anomaly into sub-queries (`02-agentic-retrieval/01-agentic-rag.md`), runs them through MCP, gathers evidence. But:

  - There's no supervisor — the orchestration is deterministic code.
  - There's no fan-out — all sub-queries run sequentially in one diagnostic agent's loop.
  - There's no synthesis agent — the `Diagnosis` output is the final word; no second agent synthesizes across multiple investigations.
  - There's no parallel retrieval across sources — one source (Bloomreach MCP), one agent per investigation.

  The shape is "single-agent agentic RAG inside a deterministic pipeline," not "supervisor + parallel workers + synthesis."

- **How to make it apply:** the refactor would touch four files and add three:

  1. **Add `lib/agents/supervisor.ts`** — a new agent class that wraps `runAgentLoop` with worker agents exposed as tools. The supervisor's `tools` would be `[run_diagnostic_worker, run_recommendation_worker, ...]`. Each tool call dispatches to one of today's agent classes wrapped as an in-process tool handler.

  2. **Add `lib/agents/synthesis.ts`** — a synthesis agent that takes N worker outputs and merges them into one structured response. The synthesis prompt would instruct it to surface conflicts ("worker A and worker B disagreed on X — present both") rather than average them.

  3. **Add a second `DataSource` adapter for the parallel-retrieval gain to be real.** Today there's one Bloomreach MCP server. The research-assistant template assumes multiple sources (e.g. a docs MCP + a Bloomreach MCP + a web-search MCP). Without adding a second source, the parallelism would be wasted (the single-source MCP rate limit serializes the wire anyway — see `05-production-serving/02-fan-out-backpressure.md`).

  4. **Refactor `app/api/agent/route.ts`** — replace the deterministic dispatch (today's `if (step === 'recommend') ... else ...`) with a supervisor invocation. The supervisor reads the user's question, decomposes it, dispatches to workers, calls the synthesis agent at the end.

  5. **Add fan-out backpressure infrastructure** — `p-limit` semaphore over outbound worker calls; queue-depth signal back to the supervisor; per-run worker cap; per-worker iteration cap. Without this, the supervisor can spawn unbounded workers and burn the 300s route budget on queueing.

  6. **Add citation tracking to the `Diagnosis`/`Recommendation` types** — today these are flat structures with `evidence: string[]` arrays; the research-assistant template needs `evidence: { source, query, snippet }[]` so the synthesis can render citations.

  7. **Modify the eval surface** to add trajectory eval per worker (today the 144 Vitest tests assert against one agent's trajectory; the new tests would assert that the supervisor dispatched to the right workers in the right order with the right sub-questions).

  The honest reality: this refactor is plausible if the product roadmap moves toward "deep research questions across multiple Bloomreach products + external sources." It doesn't apply if the roadmap stays in the current shape (one workspace, one MCP, click-to-investigate anomalies). The system-design template question is "what would it take?" — the answer is the refactor list above; whether to *take* it is a product decision.

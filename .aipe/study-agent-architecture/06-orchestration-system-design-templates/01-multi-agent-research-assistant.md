# Multi-agent research assistant

A generic interview-style design template, reframed against this codebase. Nine bullets in the standard shape.

- **The prompt:** "Design a system that answers a complex research question by gathering from multiple sources and synthesizing."

- **Standard architecture:** supervisor decomposes the question into sub-questions → parallel worker agents each retrieve from a source (agentic RAG per worker over its source) → supervisor synthesizes the workers' outputs into one answer with citations. The fan-out + synthesis shape:

```
  Standard multi-agent research assistant

  ┌─ Supervisor ─────────────────────────────────────────────┐
  │  decomposes question → [sub_q1, sub_q2, sub_q3]           │
  └─────────────────────────┬────────────────────────────────┘
                            │ fan out
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
  ┌──────────┐       ┌──────────┐       ┌──────────┐
  │ worker 1  │      │ worker 2  │      │ worker 3  │  (concurrent)
  │ vector_   │      │ web_      │      │ sql_      │
  │ search    │      │ search    │      │ query     │
  └────┬─────┘       └────┬─────┘       └────┬─────┘
       └────────────────┬─┴──────────────────┘
                        ▼
                  ┌──────────────┐
                  │ merge agent  │  synthesize +
                  │              │  citation track
                  └──────────────┘
```

- **Data model:** source registry (which sources are available + how to query each); per-worker retrieval indices (vector store per corpus, plus SQL connections, plus web-search API); a shared findings store keyed by sub-question (each worker writes its findings here); citation provenance (every claim in the final answer links back to a worker's retrieved chunk).

- **Key components:**
  - **Decomposition** (supervisor) — breaks question into sub-questions; LLM call with a structured-output schema
  - **Parallel retrieval** (workers) — one per sub-question; each runs agentic RAG against its source
  - **Synthesis** (merger) — combines workers' outputs; deduplicates, resolves contradictions, attaches citations
  - **Citation tracking** — every claim in the final output must trace back to a worker's evidence
  - **Decision per component:** tools-style delegation (supervisor calls workers as tools, retains control) vs handoff-style (control transfers to worker, then back) — this shapes the trace and debuggability; shared state (all workers see the findings store) vs message passing (each worker sees only its sub-question) — this shapes context bloat

- **Scale concerns:**
  - At many sources: fan-out cost grows with N (more workers, more synthesis tokens) — cap with concurrency limiter
  - At deep questions: iteration blowup (a sub-question that fails decomposes into more sub-questions, recursively) — cap with max depth
  - At high volume: the supervisor becomes the bottleneck (cheap workers, expensive supervisor only)

- **Eval framing:**
  - **Trajectory eval** — did each worker hit the right source? did the decomposition produce non-overlapping sub-questions?
  - **Answer groundedness** — every claim cites a retrieved chunk; structural check + LLM-as-judge
  - **Cost / latency per question** — sum across all workers + supervisor calls; latency is the slowest worker + synthesis

- **Common failure modes:**
  - Synthesis of contradictory sources (worker 1 says X; worker 2 says ¬X — averaging is wrong; flag the conflict)
  - Citation hallucination (the synthesizer invents a citation that doesn't actually back the claim)
  - Cost blowup from deep loops (a worker re-decomposes its sub-question and re-fans-out)
  - Lost-in-the-middle across many worker results (supervisor's synthesis prompt has 10 workers' outputs and attention degrades)

- **Applies to this codebase:** **No, not in the multi-source sense.** This repo has one knowledge source — live Bloomreach data via MCP. There's no fan-out (no parallel workers), no synthesis (the route handler passes diagnosis → recommendation as message-passing, not as a merge), no citation tracking (the diagnostic agent's evidence cites tool calls within its own loop, not across workers). The closest analogue is the diagnostic agent's "generate 2-3 hypotheses and test each" — but that's *sequential* exploration within one agent, not parallel fan-out across workers.

- **How to make it apply:** Three concrete refactors would turn this repo into a research-assistant shape:
  1. **Add a corpus.** Past investigations stored as markdown (already saved as JSON via `lib/state/investigations.ts`; would need an embed-on-save step), Bloomreach product docs ingested, marketer best-practice guides curated.
  2. **Add a knowledge worker.** New agent class wrapping `vector_search(query, top_k, source)` as the tool. The MonitoringAgent stays single-agent ReAct; a new `KnowledgeAgent` joins the topology.
  3. **Restructure the diagnostic flow.** Instead of one DiagnosticAgent ReAct loop, fan out: `DiagnosticDispatcher` decomposes the anomaly into 2-3 hypotheses → `KnowledgeWorker` retrieves "have we seen this before" + `DataWorker` runs the Bloomreach EQL queries → `DiagnosticMerger` synthesizes with citation tracking. The user-visible diagnosis shape stays the same; the under-the-hood becomes a true multi-agent research assistant. Prerequisite work: pgvector + embedding pipeline (`../02-agentic-retrieval/01-agentic-rag.md`), concurrency cap for fan-out (`../05-production-serving/02-fan-out-backpressure.md`), synthesis-merger logic with conflict detection (`../03-multi-agent-orchestration/09-coordination-failure-modes.md` synthesis-failure mitigation).

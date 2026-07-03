# Multi-agent research assistant

- **The prompt:** "Design a system that answers a complex research question by gathering from multiple sources and synthesizing a grounded answer with citations."

- **Standard architecture:**

  ```
  User question
       │
       ▼
  ┌─ LLM SUPERVISOR ───────────────────────────────────────────────┐
  │  decomposes: "which sources are relevant? in which sub-        │
  │              questions? which workers should run in parallel?" │
  └────────┬──────────────────┬──────────────────┬─────────────────┘
           ▼                  ▼                  ▼
     ┌──────────┐        ┌──────────┐      ┌──────────┐
     │ worker A │        │ worker B │      │ worker C │  (parallel fan-out)
     │ vector DB│        │  SQL     │      │ web      │
     └────┬─────┘        └────┬─────┘      └────┬─────┘
          └───────────────────┼─────────────────┘
                              ▼
  ┌─ Synthesis agent ─────────────────────────────────────────────┐
  │  merges findings, resolves conflicts, cites each claim        │
  │  emits: final answer + provenance list                         │
  └───────────────────────────────────────────────────────────────┘
  ```

- **Data model:**

  - Source registry — the set of retrievable sources with per-source metadata (freshness guarantee, cost per query, embedding dimension if vector).
  - Per-worker retrieval index — vector DB (semantic), SQL (structured), web-search API (fresh); one per source class.
  - Findings store — sub-question → worker result mapping, keyed for the synthesis step.
  - Citation provenance — every retrieved chunk carries source ID, retrieval score, and offset, so the synthesis output can cite specifically.
  - Question decomposition tree — the supervisor's plan of sub-questions and worker assignments.
  - Session transcript — for cross-turn debugging and eval.

- **Key components:**

  - **LLM supervisor** (Sonnet or Opus) — decomposes the question, plans the workers, synthesizes results. Decision: LLM supervisor over deterministic because the sub-question decomposition genuinely can't be enumerated upfront ("what are Bloomreach's competitors?" has different decompositions than "what caused checkout conversion to drop?").
  - **Parallel workers** — each is a single-agent ReAct loop with agentic RAG over one source class (see `02-agentic-retrieval/01-agentic-rag.md`). Decision: workers stay bounded (2-3 turns each, per-source token cap) so the supervisor doesn't get starved by any one branch.
  - **Merge/synthesis agent** — combines worker outputs, resolves contradictions, writes the final answer with inline citations. Decision: separate from the supervisor to keep the two roles clean (planning vs synthesizing benefit from different prompts).
  - **Citation validator** — every claim in the synthesis must trace to a specific worker result. Decision: post-synthesis type-guard or model self-check; rejected outputs go back to synthesis with the missing citation flagged.
  - **Fan-out concurrency cap** — semaphore or worker pool over source classes. Decision: same shape as `05-production-serving/02-fan-out-backpressure.md`.
  - **Iteration budget across the whole run** — supervisor iterations + worker iterations + synthesis iterations. Decision: unified BudgetTracker so the supervisor can't unbound its own runtime.

- **Scale concerns:**

  - **At many sources** (~50+), fan-out fan-out cost dominates. Threshold: when total worker parallelism exceeds provider rate limit divided by average worker duration. Mitigation: source pre-filtering ("which sources are likely relevant?") via a cheap classifier before spinning up workers.
  - **At deep questions** (5+ sub-questions), iteration blowup. Threshold: total-run iteration count > 20. Mitigation: cap sub-question depth in the supervisor prompt + hard iteration cap; force early synthesis with partial results.
  - **At high volume** (~10 QPS), supervisor becomes bottleneck. Threshold: p50 supervisor latency > 3s. Mitigation: cheap workers (Haiku) + expensive supervisor only; consider caching decompositions for common question patterns.
  - **Cross-source disagreement** — same fact returned differently by two sources. Threshold: >10% of claims have source disagreement. Mitigation: synthesis explicitly surfaces conflicts instead of averaging; the answer says "source A says X, source B says Y."

- **Eval framing:**

  - **Trajectory eval:** did each worker hit the right source? Measured against a golden set of question → expected-source-list.
  - **Answer groundedness:** every claim in the synthesis cites a retrieved chunk. Zero-tolerance metric for uncited claims.
  - **Cost/latency per question** — the business case. Multi-agent's 2-5x overhead has to buy measurable quality lift.
  - **Answer quality vs single-agent baseline** — head-to-head A/B against a single-agent RAG. Multi-agent must win, not just cost more.
  - **Adversarial questions:** questions with no good answer, questions that trigger source disagreement, questions requiring reasoning across sources.

- **Common failure modes:**

  - **Synthesis of contradictory sources.** Two workers return different facts; synthesis picks one arbitrarily. Mitigation: surface conflicts explicitly in the answer; never silently average or pick.
  - **Citation hallucination.** Synthesis claims a source said X when it didn't. Mitigation: citation validator matches claims to retrieved chunk offsets; reject if unmatchable.
  - **Cost blowup from deep loops.** Supervisor decomposes into 8 sub-questions, each worker runs 5 turns, cost hits 40x the single-question baseline. Mitigation: BudgetTracker at the run level (not per-worker); force early synthesis when budget approaches ceiling.
  - **Lost-in-the-middle across worker results.** Synthesis receives 12 worker outputs, the middle 6 get ignored. Mitigation: cap workers per question; if more sources needed, run two synthesis passes (map-reduce).
  - **Supervisor confusion.** LLM supervisor decomposes badly (repeated sub-questions, missed source class). Mitigation: post-decomposition validator (heuristic) that catches obvious bad plans; cascade to human on repeated failures.

- **Applies to this codebase:** no. Blooming rejected this shape by design. The supervisor is TypeScript, not an LLM (see `03-multi-agent-orchestration/02-supervisor-worker.md`). There's no parallel worker fan-out over source classes; the diagnostic loop is one agent going deep on one question. Bloomreach is the single source; there's no source registry, no synthesis-agent step. Blooming's flow is inherently sequential (diagnose → recommend) because the recommendation depends on the diagnosis. The research-assistant shape is what a codebase looks like when the sub-question decomposition genuinely can't be enumerated — blooming's decomposition (monitor → diagnose → recommend) IS enumerable, so the LLM-supervisor overhead would buy nothing.

- **How to make it apply:** significant re-architecture. Three changes: (1) Multiple source classes — today the only source is Bloomreach via MCP; adopting this template means adding at least one more retrievable source (e.g. Bloomreach docs via vector DB, or industry benchmarks). (2) LLM supervisor — replace `route.ts`'s deterministic dispatch with a Sonnet supervisor that decomposes queries and dispatches to workers. Cost premium: ~1 model call per hop, roughly 20-30% latency and cost increase. (3) Synthesis agent — a new stage that merges the workers' outputs into a single answer with citations. This is a meaningful complexity jump; earn it only when the sub-questions genuinely can't be enumerated at the code level. For blooming's known-flow work, deterministic supervisor beats this on cost, latency, observability, and predictability.

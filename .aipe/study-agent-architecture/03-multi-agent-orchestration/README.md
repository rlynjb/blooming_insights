# Section C — Multi-agent orchestration

**Anchor:** multi-agent (primary). **This is the load-bearing new material.**

blooming_insights is a *deterministic-supervisor multi-agent system* — the outer supervisor is TypeScript (not an LLM), and the workers are ReAct-loop agents. This is the recommended production shape per Anthropic's "Building Effective Agents" (2024).

## Files

1. **`01-when-not-to-go-multi-agent.md`** — read this first. The single most important multi-agent decision is whether to be multi-agent at all.
2. **`02-supervisor-worker.md`** — the shape this repo runs. Deterministic supervisor variant.
3. **`03-sequential-pipeline.md`** — diagnose → recommend. Chain of specialized agents.
4. **`04-parallel-fan-out.md`** — partial. Monitoring runs 10 categories concurrently (fan-out over queries, not over agents). Would fan out to worker agents if the diagnostic sub-questions grew.
5. **`05-debate-verifier-critic.md`** — not used. Where it would earn its keep and why not here.
6. **`06-swarm-handoff.md`** — rejected by design. Why supervisor-worker beats swarm for observability.
7. **`07-graph-orchestration.md`** — not used. Where LangGraph-shape would help (human-in-the-loop pauses).
8. **`08-shared-state-and-message-passing.md`** — this repo uses both: workspace schema (shared) + diagnosis-handed-to-recommend (message).
9. **`09-coordination-failure-modes.md`** — what breaks and what bounds it. BudgetTracker, per-call timeouts, is_error graceful degradation, session isolation.

## Reading order

01 → 02 → 03 → 04 → 08 → 09 (the shapes this repo uses, then failures). 05, 06, 07 as reference for shapes rejected.

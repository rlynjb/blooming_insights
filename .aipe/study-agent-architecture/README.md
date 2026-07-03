# Study — agent architecture (blooming_insights)

Per-codebase study guide for agent reasoning patterns, retrieval-as-a-capability, and multi-agent orchestration.

## Reading order

1. **`00-overview.md`** — the whole system, one diagram.
2. **`01-reasoning-patterns/`** — the loop that sits underneath every worker.
3. **`02-agentic-retrieval/`** — cross-references `study-ai-engineering`; none of the retrieval-loop patterns are exercised here.
4. **`03-multi-agent-orchestration/`** — the load-bearing new material. Start with `01-when-not-to-go-multi-agent.md`.
5. **`04-agent-infrastructure/`** — context, memory, tools, evals, guardrails.
6. **`05-production-serving/`** — caching, backpressure, breakers scoped to the loop.
7. **`06-orchestration-system-design-templates/`** — three interview templates.
8. **`agent-patterns-in-this-codebase.md`** — the summary table.

## Shape classification

Hybrid: **outer chain / inner single-agent**, with the classifyIntent router being the closest thing to a full multi-agent supervisor. This is a *deterministic-supervisor multi-agent* system per Anthropic's own taxonomy. See `03-multi-agent-orchestration/02-supervisor-worker.md`.

## Cross-references

- Retrieval mechanics (embeddings, chunking, RAG, GraphRAG) live in `.aipe/study-ai-engineering/03-retrieval-and-rag/` — not re-taught here.
- ReAct Thought-Action-Observation mechanics live in `.aipe/study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md` — placed here in the family, not re-taught.
- Single-call caching / cost / retry mechanics live in `.aipe/study-ai-engineering/06-production-serving/` — the loop-level variants live in `05-production-serving/`.

# AI engineering — study guide index

Per-repo AI engineering study guide for **blooming_insights**. Follows the `study-ai-engineering.md` spec (v1.69.2) with the `format.md` per-concept file template.

## Codebase shape

**LLM application engineering** — five agent classes wrapping `@aptkit/core` primitives, one DataSource port with a live MCP adapter and swappable auth, a 10-case eval harness with two rubrics and a regression gate. No classical ML in this repo.

## Reading order

1. [00-overview.md](00-overview.md) — the whole system in one picture.
2. [01-llm-foundations/](01-llm-foundations/) — the interface-level model and the primitives every agent uses.
3. [04-agents-and-tool-use/](04-agents-and-tool-use/) — where most of the codebase lives.
4. [05-evals-and-observability/](05-evals-and-observability/) — the harness that keeps the agents honest.
5. [02-context-and-prompts/](02-context-and-prompts/) — the context-window discipline behind the prompts.
6. [03-retrieval-and-rag/](03-retrieval-and-rag/) — retrieval concepts as study material; the codebase does not yet exercise RAG.
7. [06-production-serving/](06-production-serving/) — caching, cost, injection, rate limiting, retries.
8. [07-system-design-templates/](07-system-design-templates/) — interview reframes (Search ranking, Tech support chatbot).
9. [ai-features-in-this-codebase.md](ai-features-in-this-codebase.md) — the actual AI features the repo ships.

## Not included

- **08-machine-learning/** and **09-ml-system-design-templates/** — no trained model in this repo. Skipped per spec ("Concepts that don't apply to this codebase's shape at all … are skipped — no file generated").
- **ml-features-in-this-codebase.md** — same reason.

## Per-sub-section index

Each sub-section has its own `README.md` listing the concept files inside it, with anchors to the load-bearing files in the repo.

# study-agent-architecture · blooming insights

A per-codebase study guide for the agent architecture that ships in this repo. The shape: **minimal multi-agent**. Five agents (monitoring, diagnostic, recommendation, query, intent), all thin wrappers over `@aptkit/core@0.3.0`, wired together by *deterministic route code* — not an LLM supervisor. The orchestration topology is a sequential pipeline (monitoring → diagnostic → recommendation) plus a one-shot intent router for free-form queries.

If you only read one file, read [`agent-patterns-in-this-codebase.md`](./agent-patterns-in-this-codebase.md). It enumerates every agent loop in the repo with the pattern it instantiates and the control envelope it ships.

## Reading order

The sub-sections walk wide-to-narrow: a single-agent loop is the substrate, retrieval and orchestration sit on top, infrastructure and serving wrap around. Read A → B → C → D → E → F.

```
  How to read this guide

  ┌─ A. Reasoning patterns ──────────────┐  what one agent does
  │   01-reasoning-patterns/             │  ReAct, plan-execute, the loop kernel
  └────────────────┬─────────────────────┘
                   │  pull in retrieval as a control loop
  ┌─ B. Agentic retrieval ───────────────┐
  │   02-agentic-retrieval/              │  not in this repo (workspace-as-tool, not RAG)
  └────────────────┬─────────────────────┘
                   │  compose many agents
  ┌─ C. Multi-agent orchestration ───────┐  ← THE LOAD-BEARING SECTION
  │   03-multi-agent-orchestration/      │  for this repo's "what's above one agent"
  └────────────────┬─────────────────────┘
                   │  cross-cutting infrastructure
  ┌─ D. Agent infrastructure ────────────┐
  │   04-agent-infrastructure/           │  context, memory, tools, evals, guardrails
  └────────────────┬─────────────────────┘
                   │  serving concerns once the unit is a loop
  ┌─ E. Production serving for agents ───┐
  │   05-production-serving/             │  cross-turn cache, fan-out, per-tool breaker
  └────────────────┬─────────────────────┘
                   │  put it all together as design templates
  ┌─ F. Orchestration system design ─────┐
  │   06-orchestration-system-design-templates/
  └──────────────────────────────────────┘
```

## What's in this repo (the honest framing)

- **Shape:** minimal multi-agent — three agents in a sequential pipeline plus an intent router. No supervisor LLM, no fan-out, no debate, no RAG.
- **Runtime:** every agent loop is `runAgentLoop()` inside `@aptkit/core@0.3.0`. The Blooming-owned code is a 206-LOC 3-class adapter at `lib/agents/aptkit-adapters.ts` (provider + tool registry + trace sink) and 5 thin wrapper classes in `lib/agents/{monitoring,diagnostic,recommendation,query}.ts` plus `intent.ts`.
- **Orchestration is route code.** `app/api/agent/route.ts` decides what runs next based on `?step=diagnose|recommend`. The model never picks the next agent — the route does.
- **Control envelope:** every loop has `maxTurns` + `maxToolCalls` + a forced-final synthesis turn. AptKit owns this discipline; the wrapper classes don't even configure it.
- **Data-source port (`DataSource`):** two adapters — `BloomreachDataSource` (live MCP over OAuth + ~1 req/s spacing + retry + 60s cache) and `SyntheticDataSource` (in-process Blooming-owned synthetic ecommerce). `bi:mode` = `demo` | `live-bloomreach` | `live-synthetic`.
- **Schema-gated coverage:** `lib/agents/categories.ts` runs `schemaCapabilities → coverageReport → runnableCategories` and feeds only the categories this workspace can answer into the monitoring prompt's `{categories}` slot.
- **The trace is the trajectory.** The streamed `AgentEvent` NDJSON contract IS the inspectable trajectory. There is no automated trajectory-eval harness in this repo.
- **Legacy is preserved.** `lib/agents/base-legacy.ts` still holds Blooming's hand-rolled `runAgentLoop` for revertibility. The active path does not call it.

## File index

- [`00-overview.md`](./00-overview.md) — one-page system orientation
- [`agent-patterns-in-this-codebase.md`](./agent-patterns-in-this-codebase.md) — every loop in the repo, named
- [`01-reasoning-patterns/`](./01-reasoning-patterns/) — chains vs agents, the loop kernel, ReAct, plan-execute, reflexion, ToT, routing
- [`02-agentic-retrieval/`](./02-agentic-retrieval/) — agentic RAG, self-corrective RAG, retrieval routing (all not-yet-implemented; the repo retrieves via tools, not via embeddings)
- [`03-multi-agent-orchestration/`](./03-multi-agent-orchestration/) — when not to go multi-agent, supervisor-worker, sequential pipeline (THIS repo's pattern), fan-out, debate, swarm, graph, shared state, failure modes
- [`04-agent-infrastructure/`](./04-agent-infrastructure/) — context engineering, memory tiers, tool calling and MCP, agent evaluation, guardrails
- [`05-production-serving/`](./05-production-serving/) — cross-turn caching, fan-out backpressure, per-tool circuit breaking
- [`06-orchestration-system-design-templates/`](./06-orchestration-system-design-templates/) — multi-agent research assistant, agentic support, agentic coding

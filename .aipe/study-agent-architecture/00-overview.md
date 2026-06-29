# 00 — Overview

The whole guide on one page. Read this before the sub-sections so the shape is set before the mechanics.

## What this repo is, agent-architecture-wise

`blooming_insights` runs a **sequential pipeline of three single-agent ReAct loops** — the monitoring agent fires first, the diagnostic agent runs on a user-picked anomaly, and the recommendation agent runs after the diagnosis. There is a fourth agent — the free-form query agent — sitting on a different ingress path. Each agent is one reasoning loop with tools.

There is **no LLM supervisor** in the topology. The orchestration code is deterministic TypeScript in two Next.js route handlers (`app/api/briefing/route.ts` and `app/api/agent/route.ts`), plus a deterministic intent classifier (`lib/agents/intent.ts`) that picks between query and investigation when the user types into the QueryBox.

```
  Shape — three pipelines, four single-agent loops, deterministic glue

  ┌─ /api/briefing ─────────────────────────────────┐
  │   bootstrap schema → coverage gate              │
  │      → MonitoringAgent.scan() (1 ReAct loop)    │
  │      → emit insights                            │
  └─────────────────────────────────────────────────┘

  ┌─ /api/agent (insightId)  ───────────────────────┐
  │   resolveAnomaly → DiagnosticAgent.investigate()│
  │   (step=diagnose)  → diagnosis                  │
  │       — UI hands the diagnosis to step 3 —      │
  │   → RecommendationAgent.propose()               │
  │   (step=recommend) → recommendations            │
  └─────────────────────────────────────────────────┘

  ┌─ /api/agent (q)  ───────────────────────────────┐
  │   classifyIntent (haiku) → QueryAgent.answer()  │
  │   (one ReAct loop)         → final text         │
  └─────────────────────────────────────────────────┘
```

Each `MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent` class in `lib/agents/` is a **thin wrapper** (40-120 LOC) over a corresponding AptKit class — `AnomalyMonitoringAgent`, `DiagnosticInvestigationAgent`, `RecommendationAgent`, `QueryAgent` from `@aptkit/core@0.3.0`. The AptKit runtime owns the actual ReAct loop (`runAgentLoop` in `@aptkit/runtime`). The Blooming wrappers exist to bridge three ports — model provider, tool registry, capability-trace sink — to Blooming-specific implementations.

## The three-shapes call

Workflow / single-agent / multi-agent — which one is this repo?

```
  ┌─ workflow / chain ──────┬─ single-agent ────────┬─ multi-agent ───┐
  │ engineer writes steps;  │ one ReAct loop;       │ topology of     │
  │ no autonomous loop      │ LLM picks next tool   │ coordinating    │
  │                         │                       │ agents          │
  ├─────────────────────────┼───────────────────────┼─────────────────┤
  │ THE ORCHESTRATOR        │ EACH AGENT INTERNAL   │ NOT YET         │
  │ (briefing + agent       │ (monitoring, diag,    │ (no LLM         │
  │  route handlers)        │  rec, query — four    │  supervisor,    │
  │                         │  ReAct loops)         │  no debate,     │
  │                         │                       │  no handoff)    │
  └─────────────────────────┴───────────────────────┴─────────────────┘
```

The repo is a **workflow outside, single-agent inside**. The outer shell is a pipeline whose order is hard-coded; each stage in the pipeline is itself an autonomous ReAct loop with a bounded tool budget.

This calls the weighting for the rest of the guide:

- **Section A — reasoning patterns:** full coverage. Every agent in the repo is an instance of these.
- **Section B — agentic retrieval:** placement coverage. The repo does **agentic data-retrieval** (the agents drive their own EQL queries against Bloomreach via MCP), but it is not RAG over a vector store — there is no embedding layer.
- **Section C — multi-agent orchestration:** structural coverage. The repo does *not* run an LLM supervisor, debate, handoff, or graph orchestration. The `01-when-not-to-go-multi-agent.md` file is load-bearing here — the deliberate non-escalation is the lesson. Topology files mark themselves "Not yet implemented" honestly.
- **Section D — agent infrastructure:** full coverage. Context engineering (the schema-summary trick), tool calling and MCP (the connective tissue), agent evaluation (Vitest with injected fakes), guardrails (caps, budgets, allowlists, no-LLM-direct-side-effects) — all live and exercised.
- **Section E — production serving:** full coverage. Cross-turn caching (the 60s DataSource cache + Anthropic prompt prefix), per-tool rate-limit / circuit-breaker (the BloomreachDataSource retry ladder), fan-out backpressure (the ~1 req/s spacing).
- **Section F — orchestration system design templates:** all three generic templates appear; the "Applies to this codebase" bullet is the honest match.

## The settled vocabulary you'll see throughout

The guide uses **industry terms** in prose with the **repo's local names** in parens on first mention. This is the same dependency-inversion vocabulary `lib/data-source/types.ts` already uses internally:

- **Port** — `DataSource` (the abstract surface), plus the AptKit primitives `ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`.
- **Adapter** — `BloomreachDataSource`, `SyntheticDataSource`, plus the three bridge classes in `lib/agents/aptkit-adapters.ts` (`AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter`).
- **Client** — the four agent classes (`MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`).
- **Factory** — `makeDataSource(mode, sessionId)` in `lib/data-source/index.ts`.
- **Runtime** — `@aptkit/core@0.3.0` (re-exports `@aptkit/runtime`, `@aptkit/tools`, `@aptkit/context`, plus four `agent-*` packages).
- **Supervisor / orchestrator** — the deterministic ROUTE code in `app/api/briefing/route.ts` and `app/api/agent/route.ts`. **NOT** an LLM supervisor.
- **ReAct loop** — `runAgentLoop` in `node_modules/@aptkit/core/node_modules/@aptkit/runtime/dist/src/run-agent-loop.js` (the actual `while` loop with the `step / execute / accumulate / terminate` skeleton).
- **Tool calling** — Anthropic-native `tool_use` / `tool_result` blocks; the message shape is built in `runAgentLoop` and adapted to Anthropic in `BloomingToolRegistryAdapter` + `AnthropicModelProviderAdapter`.
- **Capability gating** — the per-agent `allowedTools` allowlist in each AptKit agent (`anomalyMonitoringToolPolicy`, `diagnosticInvestigationToolPolicy`, `recommendationToolPolicy`, `queryToolPolicy`); plus the schema-coverage gate in `lib/agents/categories.ts`.
- **Intent classifier** — `classifyIntent` in `lib/agents/intent.ts` (Haiku-backed, deterministic single-shot, no loop).

## Reading order

A → B → C → D → E → F, with `agent-patterns-in-this-codebase.md` at the root as the "what does my repo actually do" reference. The README has the full index.

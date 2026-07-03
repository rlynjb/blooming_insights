# Agent architecture — overview

**Shape:** multi-agent (deterministic supervisor + 5 workers).
**Runtime:** `@aptkit/core@0.3.0` — Blooming adapters bridge Anthropic + MCP into AptKit's provider-neutral surface.
**Anchor claim:** The control flow is **written in TypeScript**, not decided by a router LLM. What's autonomous is what happens *inside* each worker (an AptKit ReAct loop with a tool budget).

## The whole system in one picture

```
  Zoom out — blooming_insights, at the agent-topology level

  ┌─ UI (Next.js App Router) ─────────────────────────────────────┐
  │  app/page.tsx (feed)                                          │
  │  app/investigate/[id]/page.tsx (diagnose)                     │
  │  app/investigate/[id]/recommend/page.tsx (recommend)          │
  │  StatusLog ← ReasoningTrace ← NDJSON stream                   │
  └───────────────────────────┬───────────────────────────────────┘
                              │ fetch + ReadableStream reader
  ┌─ Service (route.ts) ──────▼───────────────────────────────────┐
  │  /api/briefing  → runs MonitoringAgent (fan-out over 10 cats) │
  │  /api/agent     → deterministic supervisor: classify or       │
  │                    diagnose → recommend                       │
  │                                                               │
  │  ★ THE SUPERVISOR IS CODE, NOT AN LLM ★                       │
  └───────────────────────────┬───────────────────────────────────┘
                              │
  ┌─ Worker agents (lib/agents, thin wrappers over AptKit) ───────┐
  │  MonitoringAgent · DiagnosticAgent · RecommendationAgent      │
  │  QueryAgent · classifyIntent (Haiku router)                   │
  │                                                               │
  │  each = AptKit ReAct loop (step → tool → observe → repeat)    │
  │  bounded by maxTurns=8, maxToolCalls=6                        │
  └───────────────────────────┬───────────────────────────────────┘
                              │ tool_use via BloomingToolRegistryAdapter
  ┌─ Data source (lib/data-source) ───────────────────────────────┐
  │  BloomreachDataSource (MCP over OAuth+PKCE)                   │
  │  SyntheticDataSource (deterministic fake)                     │
  │  FaultInjectingDataSource (decorator, offline chaos)          │
  └───────────────────────────────────────────────────────────────┘
```

## The three shapes, and where this repo sits

Workflow (chain) — engineer writes the steps in code. LLM fills slots but does not choose the next step.
Single-agent — one ReAct loop with tools. Model decides which tool to call and when to stop.
Multi-agent — many coordinating agents in a topology.

**This repo is a hybrid, and that's the interesting bit:**

```
  outer layer: deterministic pipeline (CODE picks the next agent)
      ├─ classifyIntent (Haiku) → route to QueryAgent OR skip
      ├─ MonitoringAgent (fan-out over runnable categories)
      └─ DiagnosticAgent → RecommendationAgent (sequential)

  inner layer: each agent runs a single-agent ReAct loop
      └─ AptKit runAgentLoop (step + execute + accumulate + terminate)

  innermost: tools (execute_analytics_eql, list_scenarios, …)
```

The **outer topology is chain-shaped** — the sequence diagnose → recommend is written in `app/api/agent/route.ts`, not decided by an LLM. The **inner loop is agent-shaped** — inside DiagnosticAgent, the model chooses which EQL queries to run and when to stop. This is the recommended production posture: predictable control flow at the top, autonomous loops only where the path genuinely can't be predicted.

## What this guide covers, by sub-section

- **`01-reasoning-patterns/`** — the loop-shape substrate every worker sits on. Chains-vs-agents boundary, the AptKit ReAct kernel, plan-and-execute (not used), reflexion (not used), ToT (not used), routing (used: `classifyIntent`).
- **`02-agentic-retrieval/`** — none of it is exercised here. The diagnostic loop retrieves via EQL as a general tool, not as a semantic-retrieval loop. Covered honestly with "not yet implemented" + the refactor that would introduce it.
- **`03-multi-agent-orchestration/`** — the load-bearing section. Coordinator-worker (deterministic supervisor is a variant), sequential pipeline (diagnose → recommend), parallel fan-out (partial — monitoring runs categories concurrently but not agents), swarm (rejected — Anthropic's finding), graph orchestration (not used), shared state (session + workspace schema), coordination failure modes (BudgetTracker, per-call timeouts, `is_error` graceful degradation).
- **`04-agent-infrastructure/`** — context engineering (schemaSummary + AptKit context builder), agent memory (working only — no episodic/long-term), tool calling + MCP (the substrate), agent evaluation (`eval/` harness — currently live), guardrails and control (BudgetTracker + BudgetExceededError, iteration caps, no HITL).
- **`05-production-serving/`** — cross-turn caching (Anthropic ephemeral cache on system prompt, live), fan-out backpressure (no explicit limiter; ~1 req/s MCP throttle bounds it), per-tool circuit breaking (not implemented; FaultInjectingDataSource proves the agent already degrades gracefully via `is_error`).
- **`06-orchestration-system-design-templates/`** — the three generic templates (research assistant, agentic support, coding agent), each mapped to "does this repo look like this?"
- **`agent-patterns-in-this-codebase.md`** — the table of patterns this repo actually uses, with control envelope per pattern.

## The one number to hold in your head

Per-case cost: **~$0.09**. Per-phase p50: diagnose ~50s, recommend ~51s. The Anthropic ephemeral cache turns a 3168-token cache_creation into cache_read hits across every ReAct loop turn.

## Reading order

A → B → C → D → E → F. Then `agent-patterns-in-this-codebase.md` for the summary. If you're new to multi-agent, spend the most time on C — it's the load-bearing new material.

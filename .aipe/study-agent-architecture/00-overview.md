# Overview · the agent architecture in this codebase

One page. The whole system in one diagram, then the load-bearing decision behind it.

## Zoom out — the whole system

Three layers: a Next.js UI that streams NDJSON, a route layer that owns orchestration, and an AptKit-runtime layer that owns the agent loops. The DataSource seam swaps Bloomreach for synthetic without any agent code changing.

```
  blooming insights — three layers, one shape

  ┌─ UI layer (browser) ────────────────────────────────────────┐
  │  app/page.tsx              app/investigate/[id]/page.tsx     │
  │  feed (briefing)           investigate (diagnose)            │
  │  StatusLog ◄── NDJSON      RecommendationCard ◄── NDJSON     │
  └────────┬────────────────────────────┬───────────────────────┘
           │ GET /api/briefing          │ GET /api/agent?step=
           ▼                            ▼
  ┌─ Service layer (Next.js routes — orchestration lives HERE) ─┐
  │  /api/briefing  → MonitoringAgent.scan()                    │
  │  /api/agent     → step=diagnose → DiagnosticAgent           │
  │                   step=recommend → RecommendationAgent       │
  │                   q=...         → QueryAgent (after intent) │
  │                                                              │
  │  the route is the supervisor; the model never picks an agent │
  └────────┬─────────────────────────────────────────────────────┘
           │ instantiates 1 agent class per request
           ▼
  ┌─ Agent layer (lib/agents/* — thin wrappers over AptKit) ────┐
  │  MonitoringAgent      → AptKit AnomalyMonitoringAgent       │
  │  DiagnosticAgent      → AptKit DiagnosticInvestigationAgent │
  │  RecommendationAgent  → AptKit RecommendationAgent          │
  │  QueryAgent           → AptKit QueryAgent                   │
  │  intent.ts            → AptKit classifyIntent / parseIntent │
  │                                                              │
  │  Adapter bridge (lib/agents/aptkit-adapters.ts, 206 LOC):    │
  │   • AnthropicModelProviderAdapter — Anthropic SDK → AptKit   │
  │   • BloomingToolRegistryAdapter   — DataSource   → AptKit   │
  │   • BloomingTraceSinkAdapter      — Capability   → AgentEvent│
  └────────┬─────────────────────────────────────────────────────┘
           │ every agent ultimately calls AptKit's runAgentLoop()
           ▼
  ┌─ AptKit runtime (@aptkit/core@0.3.0) ───────────────────────┐
  │  runAgentLoop:  step → execute → accumulate → terminate     │
  │  with maxTurns=8 + maxToolCalls=4-6 + forced-final synthesis │
  └────────┬─────────────────────────────────────────────────────┘
           │ tool execution via the DataSource seam
           ▼
  ┌─ DataSource layer (lib/data-source/) ───────────────────────┐
  │  BloomreachDataSource   SyntheticDataSource                  │
  │  (live MCP + OAuth +    (in-process synthetic ecommerce)     │
  │   ~1 req/s + 60s cache)                                      │
  └────────┬─────────────────────────────────────────────────────┘
           │ HTTPS (Bloomreach mode only)
           ▼
  ┌─ Provider layer (Bloomreach loomi connect MCP) ─────────────┐
  │  execute_analytics_eql · get_metric_timeseries · …          │
  └──────────────────────────────────────────────────────────────┘
```

## The shape: minimal multi-agent

Five agents. None of them know about the others. The route handler runs them in order based on URL params:

```
  Sequential pipeline — orchestrated by route code, not by an LLM

  /api/briefing                 /api/agent?insightId=X&step=diagnose
        │                                       │
        ▼                                       ▼
  ┌──────────────┐  insight     ┌──────────────┐
  │ Monitoring   │  ───stash───►│ Diagnostic   │
  │ agent        │  (UI: feed)  │ agent        │
  └──────────────┘              └──────┬───────┘
                                       │  diagnosis (sessionStorage)
                  /api/agent?...&step=recommend&diagnosis=...
                                       ▼
                                ┌──────────────┐
                                │ Recommend-   │
                                │ ation agent  │
                                └──────────────┘

  Plus an intent router for free-form Q&A:
  q → classifyIntent (cheap haiku) → QueryAgent (sonnet, with tools)
```

## The load-bearing decision

Why minimal multi-agent and not a supervisor LLM? Because the steps are **known in advance**. The product workflow is fixed — *what changed → why → what to do* — so the orchestrator doesn't need to decide which agent runs next; the *URL* tells it which one. That's the difference between a workflow with three LLM-filled slots and an agent topology where the model picks the topology. This repo is closer to the former with one autonomous loop per slot.

The cost saved: no supervisor token tax, no coordination debugging, no debate-style merge logic. The cost paid: when the question genuinely doesn't fit the three-step shape (a free-form query that spans monitoring + diagnosis), the user gets the QueryAgent — a single ReAct loop with the union of tools — not a coordinated pipeline.

## What's NOT in this repo

- **No RAG, no embeddings, no vector store.** Retrieval is via MCP tools (Bloomreach EQL), not similarity search over a corpus.
- **No supervisor LLM.** The orchestrator is `route.ts` — deterministic TypeScript.
- **No fan-out / parallel agents.** The pipeline is sequential. The recommendation agent never spawns workers; the monitoring agent never queries categories in parallel.
- **No debate / verifier-critic.** The diagnosis is final; no critic agent re-grades it.
- **No automated trajectory-eval harness.** The streamed `AgentEvent` NDJSON IS the inspectable trajectory. Eval is by reading the trace.

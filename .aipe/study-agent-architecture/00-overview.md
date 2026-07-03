# Overview — the whole agent system in one diagram

*Type: system orientation*

## Zoom out — the whole system

The forest before any tree. Every box below is a real thing in this repo; every arrow is a real hop between them.

```
  blooming insights — end-to-end agent system

  ┌─ Browser (UI) ───────────────────────────────────────────────────────┐
  │  app/page.tsx  →  useBriefingStream / useInvestigation               │
  │  StatusLog (streams reasoning + tool calls)                          │
  │  x-bi-mcp-config header (base64 JSON, per fetch)                     │
  └────────────────────────────┬─────────────────────────────────────────┘
                               │ NDJSON stream (AgentEvent)
  ┌─ Next.js route (supervisor) ─────────────────────────────────────────┐
  │  app/api/briefing/route.ts   →  MonitoringAgent                      │
  │  app/api/agent/route.ts      →  classifyIntent (Haiku, coordinator)  │
  │                                 → QueryAgent | Diagnostic → Recommend│
  │  code-routed. NO supervisor LLM. Budget tracker + hooks per request. │
  └────────────────────────────┬─────────────────────────────────────────┘
                               │ agent constructs
  ┌─ Agents (aptkit + adapter bridge) ───────────────────────────────────┐
  │  MonitoringAgent · DiagnosticAgent · RecommendationAgent · QueryAgent│
  │  aptkit ReAct loop  ←→  3 adapters:                                  │
  │    AnthropicModelProviderAdapter   (SDK + ephemeral prompt cache)    │
  │    BloomingToolRegistryAdapter     (DataSource + McpToolDef)         │
  │    BloomingTraceSinkAdapter        (CapabilityEvent → AgentEvent)    │
  └────────────────────────────┬─────────────────────────────────────────┘
                               │ callTool / listTools
  ┌─ DataSource seam ────────────────────────────────────────────────────┐
  │  lib/data-source/types.ts (port)                                     │
  │  ├─ BloomreachDataSource / McpDataSource (default preset)            │
  │  ├─ SyntheticDataSource   (live-synthetic — default mode)            │
  │  └─ FaultInjectingDataSource (decorator, offline harness)            │
  └────────────────────────────┬─────────────────────────────────────────┘
                               │ transport (over the wire)
  ┌─ Provider (MCP) ─────────────────────────────────────────────────────┐
  │  Bloomreach loomi connect  (default: OAuth 2.1 + PKCE + DCR)         │
  │  OR bearer  OR anonymous   (swappable via makeAuthProvider)          │
  └──────────────────────────────────────────────────────────────────────┘
```

**What's at the top of the stack.** The browser holds a `useInvestigation` / `useBriefingStream` hook that opens a `fetch()` against `/api/agent` or `/api/briefing`, attaches a base64 `x-bi-mcp-config` header (so a visitor can point at their own MCP server via a settings modal), and consumes newline-delimited JSON as it arrives. Each NDJSON event is an `AgentEvent` — a reasoning step, a tool_call_start, a tool_call_end, an `insight`, a `diagnosis`, a `recommendation`. The `StatusLog` renders them in real time.

**What's at the bottom.** The Bloomreach loomi connect MCP server is the default, spoken over OAuth 2.1 + PKCE + Dynamic Client Registration. The MCP server is swappable: `MCP_AUTH_TYPE=bearer` or `anonymous` route through `makeAuthProvider({type, ...})`, and the settings modal can override the whole thing per request.

**What's in the middle.** That's what this guide teaches.

## Zoom in — the three shapes, and which one this is

Every agent codebase is one of three shapes. Read the table cold, then find yours.

```
  ┌──────────────────┬──────────────────────────────────────────────┐
  │ Shape            │ What the codebase exercises                  │
  ├──────────────────┼──────────────────────────────────────────────┤
  │ Workflow / chain │ Engineer writes the steps; LLM fills slots.  │
  │                  │ NO autonomous loop.                          │
  ├──────────────────┼──────────────────────────────────────────────┤
  │ Single-agent     │ One ReAct loop with tools. Model picks next  │
  │                  │ tool + when to stop.                         │
  ├──────────────────┼──────────────────────────────────────────────┤
  │ Multi-agent      │ Multiple agents in a topology. Work is split │
  │                  │ across specialties; a coordination structure │
  │                  │ decides who runs when.                       │
  └──────────────────┴──────────────────────────────────────────────┘
```

**This repo is multi-agent, code-routed.** Four specialist agents — monitoring, diagnostic, recommendation, query — each own one ReAct loop over MCP tools. Above them sits a supervisor. The supervisor is a Next.js route handler. There is no supervisor LLM.

That distinction is load-bearing. Most multi-agent frameworks put an LLM in the boss seat (LangGraph's supervisor node, AutoGen's manager). This repo doesn't — a Haiku classifier picks intent, then the route decides the sequence in TypeScript. The tradeoff:

```
  Two ways to route in a multi-agent system

  LLM-routed supervisor              Code-routed supervisor (this repo)
  ┌───────────────────┐              ┌───────────────────┐
  │   supervisor LLM  │              │   route handler   │
  │  (Sonnet, ~$0.05  │              │  (TypeScript,     │
  │   per decision)   │              │   $0, deterministic)│
  └────┬──────────────┘              └────┬──────────────┘
       │ chooses agent                    │ if step=diagnose → diag agent
       ▼                                  │ if step=recommend → rec agent
   worker agent                           ▼
                                       worker agent

  + adapts to novel decompositions      + $0 supervisor cost
  + one prompt controls everything      + full request-flow debuggability
  – unpredictable cost                  – every new route needs code
  – hard to trace decisions             – ships with the codebase, not the model
```

For this product — three well-known stages (monitor → diagnose → recommend) with a clear "what changed → why → what to do" journey — code-routing is the correct pick. The decomposition is written into `app/api/agent/route.ts:230-310` and `app/api/briefing/route.ts`. The LLMs never see it, because they never need to.

## What this guide covers

Every SECTION below is calibrated to this shape:

- **Section 01** covers the reasoning-pattern family every worker instantiates (ReAct, plan-and-execute, reflexion, etc.). The load-bearing file is the **agent loop skeleton** — the kernel every worker runs.
- **Section 02** covers retrieval as a control loop. This repo does NOT do vector retrieval; it does *tool-driven retrieval* (agents pick which EQL query to run). The section covers the pattern family so the reader can defend "I chose not to use vector RAG because …".
- **Section 03** is the load-bearing new material — nine files walking every multi-agent topology plus coordination failure modes.
- **Section 04** covers the cross-cutting infrastructure (context engineering, memory, tools, evals, guardrails).
- **Section 05** covers the three production-serving concerns that only show up once the unit of work is an autonomous loop: cross-turn caching, fan-out backpressure, per-tool circuit breaking.
- **Section 06** reframes the codebase as three system-design interview templates.

## The receipts that ship with this codebase

Every claim below is anchored to a real artifact in the repo (paths and numbers used throughout the sub-section files):

- **Prompt caching** (`lib/agents/aptkit-adapters.ts`): system prompt wrapped in `cache_control:'ephemeral'`. Live logs show cache_creation → cache_read pattern (3168-token hits).
- **Budget ceiling** (`lib/agents/budget.ts`): `BudgetTracker` + `BudgetExceededError`, checked BEFORE each dispatch. Shared across diagnostic + recommendation.
- **Fault-injecting decorator** (`lib/data-source/fault-injecting.ts`): 9 injected faults / 3 investigations / 0 failed — the tier-2 graceful-degradation receipt.
- **Baseline** (runId `2026-07-03T04-08-28-644Z`): per-case ~$0.09; p50 diagnose 50s / recommend 51s / diag-judge 38s / rec-judge 90s.
- **261 tests** (+38 vs prior regen).

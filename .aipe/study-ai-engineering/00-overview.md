# Overview — the AI stack in this codebase

One page. The whole LLM stack as a layered picture, what each box owns, what changes when a dependency rotates. If you have five minutes, read this and stop.

## What this repo is, AI-side

A Next.js app that runs the loop a human data analyst runs — *what changed → why → what to do* — against a Bloomreach Engagement workspace. Five agents (monitoring, diagnostic, recommendation, query, intent) each call `claude-sonnet-4-6` (intent uses `claude-haiku-4-5`), each holding a `ToolRegistry` backed by an MCP server. The agents' reasoning streams to the UI as NDJSON.

The shape: LLM application engineering, not classical ML. No vector store, no embeddings, no trained models. The interesting AI work is in the agent loop, the tool surface, the structured-output contracts, and the schema-gating that decides what the monitoring agent is even allowed to ask about.

## The system in one picture

This is the orientation diagram. Every concept in this guide is a zoom-in on one of these boxes.

```
  The AI stack — UI to LLM provider, layer by layer

  ┌─ UI layer (browser) ─────────────────────────────────────────┐
  │  app/page.tsx · investigate/[id]/page.tsx · QueryBox          │
  │  StatusLog ← ReasoningTrace (streams agent thinking live)     │
  └──────────────────────────────┬───────────────────────────────┘
                                 │  fetch() + ReadableStream reader
                                 │  consumes NDJSON line-by-line
                                 ▼
  ┌─ Next.js route layer ────────────────────────────────────────┐
  │  app/api/briefing/route.ts  · maxDuration = 300              │
  │  app/api/agent/route.ts     · per-phase timings, cancellation │
  │  → emits AgentEvent NDJSON  (lib/mcp/events.ts)              │
  └──────────────────────────────┬───────────────────────────────┘
                                 │  constructs an agent + hooks
                                 ▼
  ┌─ Agent layer (Blooming wrappers) ────────────────────────────┐
  │  lib/agents/{monitoring,diagnostic,recommendation,query}.ts  │
  │  thin wrappers around @aptkit/core's reusable agents          │
  │  + lib/agents/intent.ts (the cheap classifier)                │
  └──────────────────────────────┬───────────────────────────────┘
                                 │  three adapter classes bridge to AptKit
                                 ▼
  ┌─ Adapter boundary ───────────────────────────────────────────┐
  │  lib/agents/aptkit-adapters.ts   (206 LOC)                    │
  │   AnthropicModelProviderAdapter   → implements ModelProvider  │
  │   BloomingToolRegistryAdapter     → implements ToolRegistry   │
  │   BloomingTraceSinkAdapter        → implements CapabilityTraceSink │
  └─────────────┬───────────────────────────────────┬────────────┘
                │ port: ModelProvider               │ port: ToolRegistry
                ▼                                   ▼
  ┌─ Provider layer ──────────────┐   ┌─ DataSource port ────────────┐
  │  @anthropic-ai/sdk            │   │  lib/data-source/types.ts     │
  │  claude-sonnet-4-6 (agents)   │   │   ↓ implementations:          │
  │  claude-haiku-4-5-2025-10-01  │   │   - BloomreachDataSource      │
  │   (intent classifier only)    │   │     (OAuth + rate-limit + cache)│
  │  res.usage logged @ adapter   │   │   - SyntheticDataSource       │
  │  (aptkit-adapters.ts:60,65)   │   │     (in-process, 516 LOC)     │
  └───────────────┬───────────────┘   └──────────────┬───────────────┘
                  │ HTTPS                            │ HTTPS / in-proc
                  ▼                                  ▼
          Anthropic API                       Bloomreach MCP server
                                              (loomi connect, alpha)
```

The picture is layered for a reason: every adapter swap (Bloomreach → Synthetic, Anthropic → another provider, AptKit → a different agent runtime) lands on exactly one of these boxes. The agent layer never knows.

## What each layer owns

  → **UI layer.** Renders insights, investigations, and recommendations. Consumes NDJSON via `fetch()` + `ReadableStream` (not `EventSource`). The streaming surface is itself a product feature — `StatusLog` shows the agents' reasoning trace as it happens.

  → **Route layer.** The seam between the browser and the agent loop. Owns `maxDuration = 300`, `AbortSignal` threading, per-phase timings, cancellation. Constructs the agent, attaches hooks, pushes `AgentEvent`s onto the wire.

  → **Agent layer.** Five Blooming-owned wrappers around `@aptkit/core` agents. Each one is a thin constructor that builds the three adapters and hands them to AptKit. The actual ReAct loop lives in the library, not here.

  → **Adapter boundary.** `lib/agents/aptkit-adapters.ts` — 206 lines bridging Blooming's existing types (`AnthropicSDK`, `DataSource`, `ToolCall`) to AptKit's ports (`ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`). The boundary is small on purpose: the more code lives here, the more the library has to know about this app.

  → **Provider layer.** Anthropic SDK + the DataSource port. `claude-sonnet-4-6` for agents, `claude-haiku-4-5` for the intent classifier (the only cheap-model use). `res.usage` is logged per call from inside the adapter — the only telemetry the AI stack has today.

## The load-bearing seams

There are two ports the entire AI stack pivots on:

1. **The `ModelProvider` port** (`@aptkit/core`). The agents talk to *a* model provider, not *the* Anthropic SDK. `AnthropicModelProviderAdapter` is the only adapter today, but the seam means switching to Bedrock or Vertex AI is a 1-file change.

2. **The `DataSource` port** (`lib/data-source/types.ts`). The agents call tools through *a* data source, not *the* MCP transport. Two adapters live in the repo today: `BloomreachDataSource` (live, OAuth + rate-limit + 60s cache) and `SyntheticDataSource` (deterministic, in-process, used by `bi:mode=live-synthetic`). The agent layer cannot tell which is plugged in.

Together these are why a swap doesn't touch the agent code: AptKit owns the loop, the adapters own the boundary, the ports decide what's swappable.

## What's NOT here (and where to go for it)

  → **Embeddings, vector search, semantic similarity.** Not in the codebase. Section 03 covers what *is* here — schema-as-retrieval (the workspace schema is the corpus the monitoring agent retrieves from) and the 10-category gate that decides what's runnable.

  → **Trained models, supervised learning, on-device inference.** Not in this codebase. The base spec carries Section 08 (Machine Learning) and Section 09 (ML system-design templates); both are skipped here because the codebase is pure LLM application engineering.

  → **The exact prompt anatomy.** Each agent's prompt lives at `lib/agents/legacy-prompts/{agent}.md`. The deep walk is in `study-prompt-engineering/`; this guide treats prompts as atoms.

## Where to go next

  → **Want the audit?** → `audit.md`
  → **Want to know how an LLM call is shaped?** → `01-llm-foundations/`
  → **Want to know how the agent loop runs?** → `04-agents-and-tool-use/`
  → **Want the interview reframe of this codebase as a system-design prompt?** → `07-system-design-templates/`

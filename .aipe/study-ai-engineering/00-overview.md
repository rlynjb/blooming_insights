# blooming insights — AI/ML surface map

blooming insights is an **LLM application engineering** codebase: five single-purpose agents (monitoring / diagnostic / recommendation / query / intent) ship from `@aptkit/core@0.3.0`, wired into this repo by **three Blooming-owned adapter classes** in `lib/agents/aptkit-adapters.ts` (Anthropic ModelProvider, DataSource ToolRegistry, NDJSON TraceSink), share AptKit's tool-use loop, call read-only tools through a `DataSource` seam (Bloomreach MCP in prod; a Blooming-owned in-process `SyntheticDataSource` for local/test — switched by `bi:mode`), extract validated structured artifacts via AptKit's per-agent output validators, and stream the whole reasoning trace to the UI as a first-class surface. The 4-pillar eval suite that used to live under `eval/` is gone (PR #8 / commit 62c24d7) — no embeddings, no vector store, no trained ML, and no quality numbers from a harness any more.

```
┌─ UI layer (React 19 client) ───────────────────────────────────────────────┐
│  app/page.tsx (feed)   investigate/[id] (diagnose) ─▶ /recommend   QueryBox   │
│   fetch /api/briefing    useInvestigation(id, step) — getReader +    ?q=      │
│        │                 TextDecoder NDJSON line-buffer · sessionStorage      │
│        │                 stash + bi:diag:<id> diagnosis handoff      │         │
└────────│──────────────────────────│──────────────────────────────────│───────┘
         │                          │  NDJSON stream (ReadableStream)   │
         ▼   Network boundary       ▼  ?step=diagnose | recommend | (∅) ▼
┌─ Service layer (Next route handlers, maxDuration 300) ──────────────────────┐
│  /api/briefing               /api/agent  ?step=                              │
│  monitoring → insights       cache-replay (filterByStep) │ live              │
│  + deriveInsightFields       intent route (heuristic+haiku) ─┐               │
│        │                     diagnose · recommend · ∅=combined│ QueryAgent    │
│        ▼                     bootstrap emitted INSIDE stream  ▼               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ lib/agents/base.ts  runAgentLoop  — the one Claude tool-use loop       │   │
│  │   thought → tool_use → tool_result → … (maxToolCalls budget)          │   │
│  │   forced-final tool-less turn + synthesisInstruction                  │   │
│  │   ▲ monitoring   ▲ diagnostic   ▲ recommendation   ▲ query            │   │
│  │   each = prompt + tool subset + validator + (diag/reco) synthesize()  │   │
│  └───────┬───────────────────────────────────────────┬──────────────────┘   │
│   Anthropic SDK (sonnet-4-6 agents · haiku classifier)│ McpCaller.callTool    │
│          │                                            ▼                       │
│   ┌─ structured-output boundary ──┐   ┌─ provider/transport seam ─────────┐  │
│   │ lib/mcp/validate.ts           │   │ lib/mcp/client.ts  McpClient       │  │
│   │  parseAgentJson → type guards │   │  60s TTL · 1.1s spacing · exp.     │  │
│   └───────────────────────────────┘   │  backoff retry (10s/20s)           │  │
│                                        │ lib/mcp/transport.ts McpTransport  │  │
│                                        └──────────────┬─────────────────────┘ │
└───────────────────────────────────────────────────────│──────────────────────┘
         │ observability (events.ts: reasoning_step/tool_call_*)│ Provider layer
┌─ State (no DB) ──────────┐                ┌─ External providers ──────────────┐
│ lib/state/insights.ts    │                │ Anthropic API (reasoning engine)  │
│ lib/state/investigations │                │ Bloomreach loomi MCP (~1 req/s)   │
│ in-mem + dev files +     │                │   — live tool calls + EQL,        │
│ committed demo-*.json     │                │     NOT an embedding index        │
└──────────────────────────┘                └────────────────────────────────────┘
```

## Legend

- **AptKit primitive adapters** (`lib/agents/aptkit-adapters.ts`, 206 LOC) — three Blooming-owned classes that bridge Blooming runtime objects to AptKit's generic primitives: `AnthropicModelProviderAdapter` (Anthropic SDK → AptKit `ModelProvider`), `BloomingToolRegistryAdapter` (`DataSource.callTool` → AptKit `ToolRegistry`), `BloomingTraceSinkAdapter` (AptKit `CapabilityTraceSink` → Blooming NDJSON event hooks). This is the load-bearing seam: AptKit owns the loop; Blooming owns the glue to its own infra. → `04-agents-and-tool-use/09-aptkit-primitive-adapters.md`, `01-llm-foundations/08-provider-abstraction.md`. Legacy fully-Blooming-authored implementations live alongside under `lib/agents/*-legacy.ts` and `lib/agents/legacy-prompts/`; they are preserved-not-active.
- **AptKit agents** (`AnomalyMonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`, intent classifier — all from `@aptkit/core`) — each is constructed with the three adapters + scoped per-agent inputs. Active prompts ship via `@aptkit/prompts`; output validators ship via `@aptkit/agent-*` validators. The investigation runs as **two steps** (`/api/agent?step=diagnose` then `?step=recommend`) with a sessionStorage `bi:diag:<id>` diagnosis handoff between them; a null `step` is the combined run used only by the dev demo-snapshot capture. → `04-agents-and-tool-use/01-agents-vs-chains.md`, `02-context-and-prompts/03-prompt-chaining.md`.
- **anomaly-coverage schema gate** (`lib/agents/categories.ts`) — before the monitoring agent runs, `schemaCapabilities → coverageReport → runnableCategories` classifies a fixed 10-category checklist against the live schema and hands `agent.scan(hooks, runnable)` (`briefing/route.ts:202–204, 223`) only the categories the data supports — *scope before spend* against the ~1 req/s budget. The same report streams per-category (`coverage_item`) to the feed's coverage grid. → `04-agents-and-tool-use/07-capability-gating.md`.
- **intent classifier** (`lib/agents/intent.ts`) — `parseIntent` heuristic in front of a cheap `claude-haiku` `classifyIntent`; routes `?q=` to the QueryAgent. → `01-llm-foundations/07-heuristic-before-llm.md`, `04-agents-and-tool-use/04-tool-routing.md`.
- **structured-output boundary** (`lib/mcp/validate.ts`) — `parseAgentJson` (fenced → bare → substring scan) + `isAnomalyArray`/`isDiagnosis`/`isRecommendationArray` type guards turn untrusted prose into typed contracts. → `01-llm-foundations/04-structured-outputs.md`.
- **streaming** (`lib/mcp/events.ts` + `app/api/agent/route.ts` + `lib/hooks/useInvestigation.ts`) — `AgentEvent`s encoded as NDJSON over a `ReadableStream`, consumed by the `useInvestigation` hook's browser `getReader()` + `TextDecoder` line-buffer loop (not `EventSource`); the hook feeds two pages (`app/investigate/[id]/page.tsx` diagnose, `…/recommend/page.tsx`) and stashes each step's result in sessionStorage. → `01-llm-foundations/05-streaming.md`.
- **McpClient** (`lib/mcp/client.ts`, configured in `lib/mcp/connect.ts:91–94`) — the single MCP choke-point: 60s TTL exact-match cache, 1.1s inter-call spacing (`minIntervalMs: 1100`) for the ~1 req/s limit, **exponential-backoff** rate-limit retry (`retryDelayMs: 10_000` → `retryCeilingMs: 20_000`, honoring any parsed server hint), no-cache-on-error. → `06-production-serving/`.
- **provider/transport seam** (`lib/mcp/transport.ts`, `McpCaller` in `base.ts`) — injectable `McpTransport` + injected Anthropic client make the loop fakeable in tests; a single LLM provider, not multi-provider switching. → `01-llm-foundations/08-provider-abstraction.md`.
- **observability** (`AgentEvent` trace + live timestamped log render + `/debug` + investigation cache) — the reasoning trace is the product *and* the telemetry: `StatusLog`/`ReasoningTrace` stamp each step with a `toLocaleTimeString` clock and `TraceContent` pretty-prints fenced JSON + markdown; the investigation cache (`lib/state/investigations.ts`) doubles as trace replay (`filterByStep`). → `05-evals-and-observability/04-llm-observability.md`.
- **retrieval** — live MCP tool calls against the active DataSource (Bloomreach EQL in prod, or the in-process `SyntheticDataSource` for local/test), deliberately **not** embedding-RAG (the corpus is a fresh, exact, queryable API). → `03-retrieval-and-rag/11-rag.md`.
- **DataSource adapter seam** (`lib/data-source/types.ts` `DataSource` interface; `bloomreach-data-source.ts` / `synthetic-data-source.ts`; `makeDataSource(mode, sessionId)` in `index.ts`) — every agent depends on `DataSource.callTool` only, so the route flips between the live Bloomreach MCP and the in-process `SyntheticDataSource` by reading `bi:mode` (`'demo'` | `'live-synthetic'` | `'live-bloomreach'`). The synthetic adapter is a deterministic fake that returns canned ecommerce events — useful as a test substrate for agent development without OAuth + rate limits. → `04-agents-and-tool-use/09-aptkit-primitive-adapters.md`.
- **eval pillar — RETIRED.** The `eval/` directory (4-pillar harness — detection / diagnosis / recommendation / regression — with LLM-as-judge rubrics, calibration receipts, and dated result dirs) was removed in PR #8 (commit 62c24d7). No portfolio numbers from a live harness, and the three concept files authored against it (`04-agents-and-tool-use/08-authoring-mcp-server.md`, `05-evals-and-observability/05-regression-evals.md`, `07-system-design-templates/03-multi-rubric-eval-pipeline.md`) are kept on-disk with RETIRED banners as a historical record of what was studied. Evals are back to Case B (study material).
- **no ML surface** — `get_customer_prediction_score` is a Bloomreach-provided MCP tool, not a local model; there are no trained classifiers, recommenders, or on-device inference. Sub-sections 08/09 and `ml-features-in-this-codebase.md` are therefore not generated.

## Sub-sections

- **[01-llm-foundations/](01-llm-foundations/README.md)** — what an LLM is, tokenization (char-budget analog), sampling, structured outputs, streaming, token economics, heuristic-before-LLM, provider seam, override locks.
- **[02-context-and-prompts/](02-context-and-prompts/README.md)** — context window (char budgeting), lost-in-the-middle (recency placement), prompt chaining.
- **[03-retrieval-and-rag/](03-retrieval-and-rag/README.md)** — embeddings → RAG → GraphRAG. **All Case B** (the codebase chose live tool-retrieval); read `11-rag.md` first for the rationale.
- **[04-agents-and-tool-use/](04-agents-and-tool-use/README.md)** — the richest sub-section: agents-vs-chains, tool calling, ReAct, tool routing, memory, error recovery, capability gating (the schema gate), authoring your own MCP server (RETIRED), **AptKit primitive adapters** (the new senior-level pattern for this refresh — own your domain glue, use a library's generic primitives).
- **[05-evals-and-observability/](05-evals-and-observability/README.md)** — observability is Case A (the trace is a product). **Evals are back to Case B** — the 4-pillar suite under `eval/` was removed in PR #8; the regression-evals concept file is preserved with a RETIRED banner.
- **[06-production-serving/](06-production-serving/README.md)** — caching, cost, prompt injection (open `?q=`), rate limiting, retry/circuit-breaker.
- **[07-system-design-templates/](07-system-design-templates/README.md)** — IK interview reframes: search ranking (`no`), tech-support chatbot (`partially`), the multi-rubric eval pipeline (RETIRED — the 4-pillar eval suite that was this codebase's worked example is gone).
- **[ai-features-in-this-codebase.md](ai-features-in-this-codebase.md)** — every AI feature in the repo and the patterns it uses.

---

# blooming insights — AI/ML surface map

blooming insights is an **LLM application engineering** codebase: four single-purpose agents share one Claude tool-use loop, call read-only Bloomreach MCP tools for data, extract a validated structured artifact from the model's prose, and stream the whole reasoning trace to the UI as a first-class surface — no embeddings, no vector store, no trained ML models.

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

- **runAgentLoop** (`lib/agents/base.ts`) — the single Claude tool-use loop every agent shares: emit `tool_use`, run the MCP tool, feed back `tool_result`, repeat until a `maxToolCalls` budget forces a tool-less final turn with a `synthesisInstruction`. → `01-llm-foundations/`, `04-agents-and-tool-use/`.
- **monitoring / diagnostic / recommendation / query agents** — each is a system prompt + a scoped tool subset + an output validator; diagnostic and recommendation add a dedicated tool-less `synthesize()` retry. The investigation runs as **two steps** (`/api/agent?step=diagnose` then `?step=recommend`) with a sessionStorage `bi:diag:<id>` diagnosis handoff between them; a null `step` is the combined run used only by the dev demo-snapshot capture. → `04-agents-and-tool-use/01-agents-vs-chains.md`, `02-context-and-prompts/03-prompt-chaining.md`.
- **anomaly-coverage schema gate** (`lib/agents/categories.ts`) — before the monitoring agent runs, `schemaCapabilities → coverageReport → runnableCategories` classifies a fixed 10-category checklist against the live schema and hands `agent.scan(hooks, runnable)` (`briefing/route.ts:202–204, 223`) only the categories the data supports — *scope before spend* against the ~1 req/s budget. The same report streams per-category (`coverage_item`) to the feed's coverage grid. → `04-agents-and-tool-use/07-capability-gating.md`.
- **intent classifier** (`lib/agents/intent.ts`) — `parseIntent` heuristic in front of a cheap `claude-haiku` `classifyIntent`; routes `?q=` to the QueryAgent. → `01-llm-foundations/07-heuristic-before-llm.md`, `04-agents-and-tool-use/04-tool-routing.md`.
- **structured-output boundary** (`lib/mcp/validate.ts`) — `parseAgentJson` (fenced → bare → substring scan) + `isAnomalyArray`/`isDiagnosis`/`isRecommendationArray` type guards turn untrusted prose into typed contracts. → `01-llm-foundations/04-structured-outputs.md`.
- **streaming** (`lib/mcp/events.ts` + `app/api/agent/route.ts` + `lib/hooks/useInvestigation.ts`) — `AgentEvent`s encoded as NDJSON over a `ReadableStream`, consumed by the `useInvestigation` hook's browser `getReader()` + `TextDecoder` line-buffer loop (not `EventSource`); the hook feeds two pages (`app/investigate/[id]/page.tsx` diagnose, `…/recommend/page.tsx`) and stashes each step's result in sessionStorage. → `01-llm-foundations/05-streaming.md`.
- **McpClient** (`lib/mcp/client.ts`, configured in `lib/mcp/connect.ts:91–94`) — the single MCP choke-point: 60s TTL exact-match cache, 1.1s inter-call spacing (`minIntervalMs: 1100`) for the ~1 req/s limit, **exponential-backoff** rate-limit retry (`retryDelayMs: 10_000` → `retryCeilingMs: 20_000`, honoring any parsed server hint), no-cache-on-error. → `06-production-serving/`.
- **provider/transport seam** (`lib/mcp/transport.ts`, `McpCaller` in `base.ts`) — injectable `McpTransport` + injected Anthropic client make the loop fakeable in tests; a single LLM provider, not multi-provider switching. → `01-llm-foundations/08-provider-abstraction.md`.
- **observability** (`AgentEvent` trace + live timestamped log render + `/debug` + investigation cache) — the reasoning trace is the product *and* the telemetry: `StatusLog`/`ReasoningTrace` stamp each step with a `toLocaleTimeString` clock and `TraceContent` pretty-prints fenced JSON + markdown; the investigation cache (`lib/state/investigations.ts`) doubles as trace replay (`filterByStep`). → `05-evals-and-observability/04-llm-observability.md`.
- **retrieval** — live MCP tool calls + EQL against Bloomreach, deliberately **not** embedding-RAG (the corpus is a fresh, exact, queryable API). → `03-retrieval-and-rag/11-rag.md`.
- **no ML surface** — `get_customer_prediction_score` is a Bloomreach-provided MCP tool, not a local model; there are no trained classifiers, recommenders, or on-device inference. Sub-sections 08/09 and `ml-features-in-this-codebase.md` are therefore not generated.

## Sub-sections

- **[01-llm-foundations/](01-llm-foundations/README.md)** — what an LLM is, tokenization (char-budget analog), sampling, structured outputs, streaming, token economics, heuristic-before-LLM, provider seam, override locks.
- **[02-context-and-prompts/](02-context-and-prompts/README.md)** — context window (char budgeting), lost-in-the-middle (recency placement), prompt chaining.
- **[03-retrieval-and-rag/](03-retrieval-and-rag/README.md)** — embeddings → RAG → GraphRAG. **All Case B** (the codebase chose live tool-retrieval); read `11-rag.md` first for the rationale.
- **[04-agents-and-tool-use/](04-agents-and-tool-use/README.md)** — the richest sub-section: agents-vs-chains, tool calling, ReAct, tool routing, memory, error recovery, capability gating (the schema gate).
- **[05-evals-and-observability/](05-evals-and-observability/README.md)** — observability is Case A (the trace is a product); evals are the Case-B gap.
- **[06-production-serving/](06-production-serving/README.md)** — caching, cost, prompt injection (open `?q=`), rate limiting, retry/circuit-breaker.
- **[07-system-design-templates/](07-system-design-templates/README.md)** — IK interview reframes: search ranking (`no`), tech-support chatbot (`partially`).
- **[ai-features-in-this-codebase.md](ai-features-in-this-codebase.md)** — every AI feature in the repo and the patterns it uses.

---
Updated: 2026-05-28 — agent-flow legend now reflects the `/api/agent?step=` split (two-step diagnose→recommend with a `bi:diag:<id>` sessionStorage handoff), bootstrap emitted inside the stream, `maxDuration` 60→300, exponential-backoff McpClient retry, and timestamped trace render; dropped the stale `summarizeTrace` reference.
Updated: 2026-05-29 — added the anomaly-coverage schema gate (`lib/agents/categories.ts`) to the legend + the 04 sub-section line, pointing at the new `04-agents-and-tool-use/07-capability-gating.md`.

# blooming insights — AI/ML surface map

blooming insights is an **LLM application engineering** codebase: four single-purpose agents share one Claude tool-use loop, call read-only tools through a `DataSource` seam (Bloomreach MCP in prod, an authored SQLite-backed MCP server `mcp-server-olist/` in eval/local — switched by `bi:mode`), extract a validated structured artifact from the model's prose, and stream the whole reasoning trace to the UI as a first-class surface. **A 4-pillar eval suite under `eval/`** (detection / diagnosis / recommendation / regression, with LLM-as-judge rubrics + manual-vs-judge calibration receipts) is the Phase-3 hardening — no embeddings, no vector store, no trained ML models, but every agent surface now has a real quality number.

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
- **retrieval** — live MCP tool calls against the active DataSource (Bloomreach EQL in prod, or the authored Olist domain tools — `get_metric_timeseries`, `get_segments`, `get_anomaly_context` — over SQLite for eval), deliberately **not** embedding-RAG (the corpus is a fresh, exact, queryable API). → `03-retrieval-and-rag/11-rag.md`.
- **DataSource adapter seam** (`lib/data-source/types.ts` `DataSource` interface; `bloomreach-data-source.ts` / `olist-data-source.ts`; `makeDataSource(mode, sessionId)` in `index.ts`) — every agent depends on `DataSource.callTool` only, so the route flips between the live Bloomreach MCP and the spawned `mcp-server-olist/` subprocess by reading `bi:mode` (`'demo'` | `'live-sql'` | `'live-bloomreach'`). The eval scripts use `live-sql` so K=10 runs spawn one fresh subprocess per run for crash isolation. → `04-agents-and-tool-use/08-authoring-mcp-server.md`.
- **eval pillar** (`eval/scripts/{run-detection,run-diagnosis,run-recommendation,run-regression}.ts` + `eval/judges/*.md` + `eval/fixtures/` + `eval/results/2026-06-15*/`) — four end-to-end evals against the real Sonnet 4.6 agents over OlistDataSource, two scored by Sonnet 4.6 LLM-as-judge under per-criterion rubrics, K=10 runs per anomaly, results committed to dated dirs. Portfolio numbers: detection 37%/33.3% loose, diagnosis 53.3% pass, recommendation 100% pass, regression 30% baseline. → `05-evals-and-observability/`.
- **no ML surface** — `get_customer_prediction_score` is a Bloomreach-provided MCP tool, not a local model; there are no trained classifiers, recommenders, or on-device inference. Sub-sections 08/09 and `ml-features-in-this-codebase.md` are therefore not generated.

## Sub-sections

- **[01-llm-foundations/](01-llm-foundations/README.md)** — what an LLM is, tokenization (char-budget analog), sampling, structured outputs, streaming, token economics, heuristic-before-LLM, provider seam, override locks.
- **[02-context-and-prompts/](02-context-and-prompts/README.md)** — context window (char budgeting), lost-in-the-middle (recency placement), prompt chaining.
- **[03-retrieval-and-rag/](03-retrieval-and-rag/README.md)** — embeddings → RAG → GraphRAG. **All Case B** (the codebase chose live tool-retrieval); read `11-rag.md` first for the rationale.
- **[04-agents-and-tool-use/](04-agents-and-tool-use/README.md)** — the richest sub-section: agents-vs-chains, tool calling, ReAct, tool routing, memory, error recovery, capability gating (the schema gate), authoring your own MCP server (domain tools vs raw EQL).
- **[05-evals-and-observability/](05-evals-and-observability/README.md)** — observability is Case A (the trace is a product) **AND evals are now Case A too** (the 4-pillar suite under `eval/` — detection / diagnosis / recommendation / regression — with judge prompts, calibration receipts, and dated paper trails). Read this sub-section as the load-bearing addition.
- **[06-production-serving/](06-production-serving/README.md)** — caching, cost, prompt injection (open `?q=`), rate limiting, retry/circuit-breaker.
- **[07-system-design-templates/](07-system-design-templates/README.md)** — IK interview reframes: search ranking (`no`), tech-support chatbot (`partially`), the multi-rubric eval pipeline (`yes` — this codebase's 4-pillar eval suite IS the answer).
- **[ai-features-in-this-codebase.md](ai-features-in-this-codebase.md)** — every AI feature in the repo and the patterns it uses.

---
Updated: 2026-05-28 — agent-flow legend now reflects the `/api/agent?step=` split (two-step diagnose→recommend with a `bi:diag:<id>` sessionStorage handoff), bootstrap emitted inside the stream, `maxDuration` 60→300, exponential-backoff McpClient retry, and timestamped trace render; dropped the stale `summarizeTrace` reference.
Updated: 2026-05-29 — added the anomaly-coverage schema gate (`lib/agents/categories.ts`) to the legend + the 04 sub-section line, pointing at the new `04-agents-and-tool-use/07-capability-gating.md`.
Updated: 2026-06-16 — Phase 2 + Phase 3 architectural delta: opening paragraph + retrieval legend entry now name the DataSource adapter seam (`bi:mode`-switched between Bloomreach and the authored `mcp-server-olist/`); added two legend entries — DataSource adapter seam (pointing at `04-agents-and-tool-use/08-authoring-mcp-server.md`) and the eval pillar (4 evals, K=10, judge prompts, dated result dirs). Sub-section pointers refreshed: 04 now mentions the authored MCP server; 05 flipped from "evals are the Case-B gap" to "evals are now Case A too"; 07 names the multi-rubric eval pipeline template.

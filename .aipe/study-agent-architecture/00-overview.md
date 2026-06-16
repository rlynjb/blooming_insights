# blooming insights — agent architecture surface

A Next.js 16 / React 19 multi-agent AI analyst over a swappable data source (Bloomreach's loomi connect MCP via OAuth, or a sibling-package `mcp-server-olist` subprocess over a seeded SQLite Olist dataset). **Dominant shape: multi-agent** — specifically the *minimal* multi-agent topology: a deterministic sequential pipeline (monitoring → diagnostic → recommendation) plus an intent router, with the typed `Diagnosis` as the inter-stage message. Orchestration is deterministic route code, not an LLM supervisor.

**A new architectural axis: adapter-switchable.** Phase 2 introduced a `DataSource` interface (`lib/data-source/types.ts`) and refactored the agents to hold a `DataSource` instead of an `McpClient`. Two adapters implement it today: `BloomreachDataSource` (the live MCP client over OAuth, relocated from `lib/mcp/client.ts`) and `OlistDataSource` (spawns the authored `mcp-server-olist` subprocess via the MCP SDK's `StdioClientTransport`). The mcp-server-olist exposes **three domain tools** (`get_metric_timeseries`, `get_segments`, `get_anomaly_context`) — never raw `execute_sql` — so the agent reasons about pre-baked period-over-period queries, not SQL. The `bi:mode` localStorage key now holds `'demo' | 'live-sql' | 'live-bloomreach'`; the route default is `'live-sql'` so the Phase 3 eval pipeline never depends on Bloomreach OAuth.

```
┌─ UI layer (Next.js App Router · React 19, client) ───────────────────────────┐
│  app/page.tsx (feed: monitoring view + CoverageGrid)                          │
│  app/investigate/[id]/page.tsx        … /recommend/page.tsx                   │
│       │  fetch /api/briefing            │  fetch /api/agent?step=…             │
│       │  (monitoring only)              │  (NDJSON: 1 step at a time)          │
│       │                                 │   ProcessStepper UI state machine     │
└───────│─────────────────────────────────│────────────────────────────────────┘
        ▼  NDJSON over ReadableStream (fetch + reader loop)
┌─ Route layer (Vercel · maxDuration = 300) ──────────────────────────────────┐
│  /api/briefing                          /api/agent  (step=diagnose|recommend) │
│  bootstrap schema                       cache-replay  (filterByStep, demo)    │
│  ▼ coverage gate                        OR live: routes to the lead agent     │
│  schemaCapabilities → coverageReport      intent path (?q=): parseIntent +    │
│   → runnableCategories                    classifyIntent → QueryAgent         │
│  ▼ monitoring.scan(hooks, runnable)                                            │
│                                                                                │
│  PIPELINE (deterministic):  monitoring ──Diagnosis──► diagnostic ──► recommend │
│      ▲ pick next agent: code, NOT an LLM supervisor                            │
│      ▲ Diagnosis handed step2→step3 via sessionStorage `bi:diag:<id>`         │
│                                                                                │
│   ┌─ runAgentLoop  (lib/agents/base.ts) — ONE shared Claude tool-use loop ──┐ │
│   │   reason → tool → observe → repeat   (ReAct)                            │ │
│   │   maxToolCalls budget · forced final synthesis turn at L90              │ │
│   │   per-agent tool subsets (lib/mcp/tools.ts, filterToolSchemas)          │ │
│   └────┬─────────────────────────────────────────────────────────────────────┘ │
│   monitoring   diagnostic   recommendation   query                            │
│   (sonnet-4-6 agents · intent classifier = haiku-4-5)                         │
│                                                                                │
│   ▼  DataSource seam (lib/data-source/types.ts): adapter-agnostic              │
│   makeDataSource(mode, sid) ─► BloomreachDataSource | OlistDataSource          │
│   Bloomreach: 60s TTL cache · ~1.1s spacing · exp-backoff retry · no-cache-on-error│
│   Olist:      subprocess + StdioClientTransport · domain tools, no rate limit  │
│                                                                                │
│   ▼  Tools = LIVE agentic retrieval                                            │
│   Bloomreach: execute_analytics_eql + read-only MCP surface (~27 tools)        │
│   Olist:      3 authored domain tools (get_metric_timeseries · get_segments ·  │
│               get_anomaly_context) — pre-baked period-over-period; no SQL      │
│   NO embeddings · NO vector store · NO RAG  (deliberate)                       │
└──────────────────────────────────────────────│──────────────────────────────┘
                                                ▼  Provider layer (network / IPC)
   Bloomreach loomi connect MCP  (~1 req/s/user, revokes tokens after minutes)
   mcp-server-olist subprocess   (local SQLite, ~10k synthetic rows + 3 seeded
                                  ground-truth anomalies for the eval suite)
   Anthropic API  (reasoning engine for every agent)
```

## What's an agent here · what's a chain

- **Each of the four agents** (monitoring, diagnostic, recommendation, query) is an autonomous ReAct loop on the shared `runAgentLoop` — the model picks the next tool until it answers or the budget forces a synthesis.
- **The pipeline above them** is *not* an agent — it's deterministic route code (`app/api/agent/route.ts`) that picks the next stage from `?step=`. The user gates each stage by navigating. There is no LLM supervisor.
- **The intent classifier** (`lib/agents/intent.ts`) is a heuristic + cheap-model router that picks which agent handles a free-form `?q=` query.

## Legend (what each piece is · what it does)

- **`runAgentLoop`** (`lib/agents/base.ts` L48–176) — the one Claude tool-use loop every agent shares; `maxToolCalls` budget (monitoring/diagnostic/query = 6, recommendation = 4) + forced final tool-less synthesis at L90; Anthropic + `McpClient` injected (fakeable in tests). → SECTION A (reasoning patterns), SECTION D (infrastructure).
- **Monitoring / Diagnostic / Recommendation / Query agents** (`lib/agents/`) — each is a prompt + a scoped tool subset + an output validator; diagnostic + recommendation add a tool-less `synthesize()` retry. → SECTION A.
- **Coverage gate** (`lib/agents/categories.ts`) — `schemaCapabilities` → `coverageReport` → `runnableCategories` scopes the monitoring agent's category checklist to what the live schema can support, *before* it spends budget. → SECTION D (guardrails), SECTION B (capability routing).
- **Pipeline + handoff** (`app/api/agent/route.ts` step-split + `lib/hooks/useInvestigation.ts`) — the route picks the lead agent from `?step=diagnose|recommend`; the typed `Diagnosis` (`lib/mcp/types.ts`) is handed step 2 → step 3 via `sessionStorage['bi:diag:<id>']`. Demo replays the cached investigation filtered to the step (`filterByStep`). → SECTION C (sequential pipeline · shared-state-and-message-passing).
- **Intent routing** (`lib/agents/intent.ts`) — `parseIntent` heuristic (L6–12) → `classifyIntent` haiku-4-5 (L17–31) → `QueryAgent`. → SECTION A (routing).
- **`DataSource` seam** (`lib/data-source/types.ts`, factory at `lib/data-source/index.ts`) — abstract `{ callTool, listTools, dispose }` contract every agent holds. Two adapters: `BloomreachDataSource` (relocated from `lib/mcp/client.ts`, the live OAuth MCP client — 60s TTL cache · ~1.1s spacing · bounded exp-backoff retry · no-cache-on-error) and `OlistDataSource` (spawns `mcp-server-olist` via `StdioClientTransport`). The legacy `lib/mcp/client.ts` is now a 17-line backwards-compat re-export. → SECTION D (tool-calling-and-mcp), SECTION E (production serving).
- **MCP transport + auth** (`lib/mcp/transport.ts` + `lib/mcp/connect.ts`) — `StreamableHTTPClientTransport` + `OAuthClientProvider` (PKCE + Dynamic Client Registration) for the Bloomreach adapter; Stdio transport for the Olist adapter. → SECTION D (tool-calling-and-mcp).
- **Authored MCP server** (`mcp-server-olist/`) — sibling Node package, ~1800 LOC. SQLite-backed Olist e-commerce dataset (~10k synthetic rows, 6-month data horizon) plus three seeded anomalies (`sp-revenue-drop-w4` critical ×0.7, `electronics-spike-w2` warning ×2.5, `voucher-dropoff-w10-on` critical ×0.05) the eval suite scores against. Exposes only three pre-baked domain tools — never `execute_sql` — so the agent's reasoning surface is the same shape regardless of which adapter is live. → SECTION D (tool-calling-and-mcp).
- **Phase 3 eval suite** (`eval/`, ~75 files) — four `npm run eval:*` runners (`run-detection.ts` · `run-diagnosis.ts` · `run-recommendation.ts` · `run-regression.ts`), Sonnet 4.6 as actor + judge, rubrics versioned at `eval/judges/*.md`, K=10 runs per anomaly with `EVAL_RUN_TAG` stamping each batch. Current portfolio numbers: 37%/33.3% detection · 53.3% diagnosis · 100% recommendation · 30% regression baseline. → SECTION D (agent-evaluation).
- **Output validators** (`lib/mcp/validate.ts`) — `parseAgentJson` + `isAnomalyArray` / `isDiagnosis` / `isRecommendationArray` reject wrong-shape model output to a safe floor. → SECTION D (guardrails).
- **Per-agent tool subsets** (`lib/mcp/tools.ts`; `lib/agents/tool-schemas.ts:15`) — the allow-list applied to `params.tools` so the model can never reach for the wrong tool. → SECTION A (routing) · SECTION D (tool calling).
- **NDJSON streaming + trace** (`lib/mcp/events.ts` `AgentEvent` + `app/api/agent/route.ts` + `lib/hooks/useInvestigation.ts`) — the reasoning trace is the inspectable trajectory (and the user-facing product). → SECTION D (evaluation).
- **State / persistence** (`lib/state/investigations.ts` + sessionStorage stashes) — working memory = the per-run `messages` array; persistence = in-memory `Map` per Vercel instance + sessionStorage; no semantic long-term tier. → SECTION D (memory).
- **Guardrails** (`maxToolCalls` caps · forced synthesis · read-only MCP tools · validators · the coverage gate · one-time guarded auto-reconnect on revoked alpha-server tokens in `app/page.tsx`) — the control envelope around the autonomous loop. → SECTION D.
- **Retrieval** — live agentic EQL through the MCP server; no embeddings / no vector store / no RAG, deliberately. → SECTION B.

## The codebase's relationship to the agent-architecture sub-sections

```
A · reasoning patterns      ── runAgentLoop = ReAct baseline; intent router is the bridge to C
B · agentic retrieval       ── retrieval is LIVE agentic EQL (no embedding-RAG; cross-ref ai-eng)
C · multi-agent orchestration ── deterministic sequential pipeline + message-passing handoff;
                                  load-bearing for this codebase, most topologies "Not yet implemented"
D · agent infrastructure    ── context engineering · memory · MCP · evaluation · guardrails (all Case A)
E · production serving      ── McpClient caching + spacing + retry (Case A); no fan-out (Case B)
F · system-design templates ── three generic 9-bullet templates the codebase is mapped against
```

The full per-feature breakdown is in [`agent-patterns-in-this-codebase.md`](agent-patterns-in-this-codebase.md). The companion guides this one cross-references rather than duplicates: [`../study-ai-engineering/`](../study-ai-engineering/) (single-agent + retrieval mechanics) and [`../study-system-design/`](../study-system-design/) (the systems-level view of the same orchestration).

---
Updated: 2026-05-29 — created
Updated: 2026-06-16 — Reflected Phase 2 DataSource seam (`lib/data-source/`), the authored sibling `mcp-server-olist` package and its three domain tools, the new `bi:mode = 'demo' | 'live-sql' | 'live-bloomreach'` triple, and the Phase 3 four-pillar eval suite with portfolio numbers.

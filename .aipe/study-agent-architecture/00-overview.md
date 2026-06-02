# blooming insights — agent architecture surface

A Next.js 16 / React 19 multi-agent AI analyst over Bloomreach's loomi connect MCP. **Dominant shape: multi-agent** — specifically the *minimal* multi-agent topology: a deterministic sequential pipeline (monitoring → diagnostic → recommendation) plus an intent router, with the typed `Diagnosis` as the inter-stage message. Orchestration is deterministic route code, not an LLM supervisor.

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
│   ▼  McpClient (lib/mcp/client.ts): the choke-point                            │
│   60s TTL cache · ~1.1s spacing · bounded exp-backoff retry · no-cache-on-error│
│                                                                                │
│   ▼  Tools = LIVE agentic retrieval (execute_analytics_eql + read-only MCP)    │
│      NO embeddings · NO vector store · NO RAG  (deliberate)                   │
└──────────────────────────────────────────────│──────────────────────────────┘
                                                ▼  Provider layer (network)
   Bloomreach loomi connect MCP  (~1 req/s/user, revokes tokens after minutes)
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
- **`McpClient`** (`lib/mcp/client.ts`, configured in `lib/mcp/connect.ts:91–94`) — the single MCP choke-point: 60s TTL cache · ~1.1s spacing (`minIntervalMs: 1100`) · bounded exp-backoff retry (`retryDelayMs: 10_000` → `retryCeilingMs: 20_000`, `maxRetries: 3`) · no-cache-on-error. → SECTION E (production serving).
- **MCP transport + auth** (`lib/mcp/transport.ts` + `lib/mcp/connect.ts`) — `StreamableHTTPClientTransport` + `OAuthClientProvider` (PKCE + Dynamic Client Registration). → SECTION D (tool-calling-and-mcp).
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

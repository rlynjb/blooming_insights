# blooming insights — agent architecture surface

A Next.js 16 / React 19 multi-agent AI analyst over a swappable data source (Bloomreach's loomi connect MCP via OAuth, or an in-process synthetic adapter over deterministic fake data). **Dominant shape: multi-agent** — specifically the *minimal* multi-agent topology: a deterministic sequential pipeline (monitoring → diagnostic → recommendation) plus an intent router, with the typed `Diagnosis` as the inter-stage message. Orchestration is deterministic route code, not an LLM supervisor.

**The active spine is AptKit-owned, not Blooming-owned.** The four agent classes in `lib/agents/{monitoring,diagnostic,recommendation,query}.ts` are now thin wrappers (each 30–100 LOC) over `@aptkit/core`'s `AnomalyMonitoringAgent` / `DiagnosticInvestigationAgent` / `RecommendationAgent` / `QueryAgent`. Blooming owns three bridge adapters in `lib/agents/aptkit-adapters.ts` (206 LOC): `AnthropicModelProviderAdapter` (Anthropic SDK → AptKit `ModelProvider`), `BloomingToolRegistryAdapter` (Blooming `DataSource` → AptKit `ToolRegistry`), `BloomingTraceSinkAdapter` (AptKit `CapabilityTraceSink` → Blooming NDJSON hooks). The legacy Blooming spine (`runAgentLoop`) is preserved at `lib/agents/base-legacy.ts` for revertibility; sibling `*-legacy.ts` files keep the legacy path intact but the active route never calls them.

**The DataSource seam survives the AptKit migration.** Every (active) agent constructor still receives a `DataSource` (`lib/data-source/types.ts`); two adapters implement it today — `BloomreachDataSource` (live OAuth MCP) and `SyntheticDataSource` (in-process, 516 LOC of deterministic fakes at `lib/data-source/synthetic-data-source.ts`). The `bi:mode` localStorage key holds `'demo' | 'live-bloomreach' | 'live-synthetic'`; the factory at `lib/data-source/index.ts`'s `makeDataSource(mode, sid)` returns the right adapter. The previously documented Olist subprocess adapter and its sibling `mcp-server-olist/` package were removed in PR #8 (commit 62c24d7); the eval/ pipeline that ran against it was removed at the same time.

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
│   ┌─ Blooming agent wrappers (lib/agents/*.ts) — 30–100 LOC each ──────────┐ │
│   │   monitoring.ts | diagnostic.ts | recommendation.ts | query.ts          │ │
│   │   each: construct AptKit agent + 3 adapters → call AptKit method        │ │
│   └────┬─────────────────────────────────────────────────────────────────────┘ │
│        │                                                                       │
│   ┌─ AptKit agent runtime (@aptkit/core v0.3.0) — the ACTIVE spine ────────┐ │
│   │   AnomalyMonitoringAgent · DiagnosticInvestigationAgent ·               │ │
│   │   RecommendationAgent · QueryAgent · parseIntent · classifyIntent       │ │
│   │   reason → tool → observe → repeat (ReAct), budget caps, forced final   │ │
│   └────┬─────────────────────────────────────────────────────────────────────┘ │
│        │                                                                       │
│   ┌─ Blooming-owned bridge (lib/agents/aptkit-adapters.ts, 206 LOC) ───────┐ │
│   │   AnthropicModelProviderAdapter  : SDK → AptKit ModelProvider          │ │
│   │   BloomingToolRegistryAdapter    : DataSource → AptKit ToolRegistry    │ │
│   │   BloomingTraceSinkAdapter       : AptKit CapabilityEvent → NDJSON hk  │ │
│   └────┬─────────────────────────────────────────────────────────────────────┘ │
│        │                                                                       │
│   (Legacy: lib/agents/base-legacy.ts `runAgentLoop` preserved, NOT on the     │
│    active path; sibling *-legacy.ts wrappers kept for revertibility.)         │
│                                                                                │
│   ▼  DataSource seam (lib/data-source/types.ts): adapter-agnostic              │
│   makeDataSource(mode, sid) ─► BloomreachDataSource | SyntheticDataSource      │
│   Bloomreach: 60s TTL cache · ~1.1s spacing · exp-backoff retry · no-cache-on-error│
│   Synthetic: in-process deterministic fakes · no rate limit · same DataSource shape│
│                                                                                │
│   ▼  Tools = LIVE agentic retrieval                                            │
│   Bloomreach: execute_analytics_eql + read-only MCP surface (~27 tools)        │
│   Synthetic: same tool shape as Bloomreach (per-agent allowlists in            │
│              lib/mcp/tools.ts), in-process responses                            │
│   NO embeddings · NO vector store · NO RAG  (deliberate)                       │
└──────────────────────────────────────────────│──────────────────────────────┘
                                                ▼  Provider layer (network / IPC)
   Bloomreach loomi connect MCP  (~1 req/s/user, revokes tokens after minutes)
   Anthropic API  (reasoning engine for every agent; called by AptKit through
                   the AnthropicModelProviderAdapter)
```

## What's an agent here · what's a chain

- **Each of the four agents** (monitoring, diagnostic, recommendation, query) is an autonomous ReAct loop. The active loop body lives inside `@aptkit/core`'s agent classes; the model picks the next tool until it answers or AptKit's internal budget forces a synthesis. Blooming's per-agent file is the thin constructor + return-mapping wrapper.
- **The pipeline above them** is *not* an agent — it's deterministic route code (`app/api/agent/route.ts`) that picks the next stage from `?step=`. The user gates each stage by navigating. There is no LLM supervisor.
- **The intent classifier** (`lib/agents/intent.ts`) is a heuristic + cheap-model router that picks which agent handles a free-form `?q=` query. Both `parseIntent` and `classifyIntent` are re-exports from `@aptkit/core`.

## Legend (what each piece is · what it does)

- **AptKit agent classes** (`@aptkit/core` v0.3.0) — the *active* ReAct runtime. Owns the loop body, budget caps, forced-final synthesis, tool dispatch through the registry, trace event emission. Used by every Blooming agent wrapper. → SECTION A (reasoning patterns), SECTION D (infrastructure), `04-agent-infrastructure/06-aptkit-runtime-layer.md`.
- **Blooming agent wrappers** (`lib/agents/{monitoring,diagnostic,recommendation,query}.ts`) — each ~30–100 LOC; constructs an AptKit agent with the three adapter objects + workspace + per-agent inputs, calls the AptKit method, maps the return back to Blooming's domain types. → SECTION A.
- **Bridge adapters** (`lib/agents/aptkit-adapters.ts`, 206 LOC) — `AnthropicModelProviderAdapter` (SDK → `ModelProvider`), `BloomingToolRegistryAdapter` (`DataSource` → `ToolRegistry`), `BloomingTraceSinkAdapter` (`CapabilityTraceSink` → NDJSON hooks). The Blooming-owned seam between two reusable libraries. → SECTION D (`06-aptkit-runtime-layer.md`).
- **Legacy spine** (`lib/agents/base-legacy.ts:86` `runAgentLoop` + per-agent `*-legacy.ts`) — preserved for revertibility; NOT on the active path. Same loop shape (ReAct + budget + forced-final), Blooming-owned. The tests cover the legacy path on legacy classes; the AptKit path is covered by AptKit's own test surface plus integration tests on the wrappers. → not load-bearing today.
- **Coverage gate** (`lib/agents/categories.ts`, with `categories-legacy.ts` preserved) — schema-driven anomaly category gate. Active wiring routes a Blooming `AnomalyCategory[]` through `toAptKitCategories` (`monitoring.ts:96–109`) into `MonitoringAnomalyCategory[]` for the AptKit agent. → SECTION D (guardrails), SECTION B (capability routing).
- **Pipeline + handoff** (`app/api/agent/route.ts` step-split + `lib/hooks/useInvestigation.ts`) — the route picks the lead agent from `?step=diagnose|recommend`; the typed `Diagnosis` (`lib/mcp/types.ts`) is handed step 2 → step 3 via `sessionStorage['bi:diag:<id>']`. → SECTION C (sequential pipeline · shared-state-and-message-passing).
- **Intent routing** (`lib/agents/intent.ts`) — `parseIntent` re-export of AptKit's; `classifyIntent` wraps the Anthropic SDK in `AnthropicModelProviderAdapter` and calls AptKit's `classifyIntent`. → SECTION A (routing).
- **`DataSource` seam** (`lib/data-source/types.ts`, factory at `lib/data-source/index.ts`) — abstract `{ callTool, listTools }` contract every agent's `BloomingToolRegistryAdapter` holds. Two adapters: `BloomreachDataSource` (live OAuth MCP — 60s TTL cache · ~1.1s spacing · bounded exp-backoff retry · no-cache-on-error) and `SyntheticDataSource` (in-process, 516 LOC, deterministic fakes). → SECTION D (tool-calling-and-mcp), SECTION E (production serving).
- **MCP transport + auth** (`lib/mcp/transport.ts` + `lib/mcp/connect.ts`) — `StreamableHTTPClientTransport` + `OAuthClientProvider` (PKCE + Dynamic Client Registration) for the Bloomreach adapter. → SECTION D (tool-calling-and-mcp).
- **Output validators** (`lib/mcp/validate.ts`) — `parseAgentJson` + `isAnomalyArray` / `isDiagnosis` / `isRecommendationArray` reject wrong-shape model output to a safe floor. → SECTION D (guardrails).
- **Per-agent tool subsets** (`lib/mcp/tools.ts`; `lib/agents/tool-schemas.ts`) — the allow-list given to the `BloomingToolRegistryAdapter` so the AptKit registry only exposes the right tools for each agent. → SECTION A (routing) · SECTION D (tool calling).
- **NDJSON streaming + trace** (`lib/mcp/events.ts` `AgentEvent` + `app/api/agent/route.ts` + `lib/hooks/useInvestigation.ts`) — the reasoning trace is the inspectable trajectory (and the user-facing product). The trace events come from `BloomingTraceSinkAdapter` translating AptKit's `CapabilityEvent` into Blooming's existing hook surface. → SECTION D (evaluation).
- **State / persistence** (`lib/state/investigations.ts` + sessionStorage stashes) — working memory = AptKit's per-run internal conversation; persistence = in-memory `Map` per Vercel instance + sessionStorage; no semantic long-term tier. → SECTION D (memory).
- **Guardrails** (AptKit-owned budgets · forced synthesis · read-only MCP tools · validators · the coverage gate · one-time guarded auto-reconnect on revoked alpha-server tokens in `app/page.tsx`) — the control envelope around the autonomous loop. → SECTION D.
- **Retrieval** — live agentic EQL through the MCP server (or synthetic equivalents under SyntheticDataSource); no embeddings / no vector store / no RAG, deliberately. → SECTION B.

## The codebase's relationship to the agent-architecture sub-sections

```
A · reasoning patterns      ── AptKit's agent classes = ReAct baseline (active);
                                Blooming's runAgentLoop preserved as LEGACY
                                spine; intent router is the bridge to C
B · agentic retrieval       ── retrieval is LIVE agentic queries through MCP
                                (no embedding-RAG; cross-ref ai-eng)
C · multi-agent orchestration ── deterministic sequential pipeline + message-passing
                                  handoff; load-bearing for this codebase, most
                                  topologies "Not yet implemented"
D · agent infrastructure    ── context engineering · memory · MCP + DataSource seam
                                + AptKit runtime layer · guardrails (Case A);
                                automated trajectory eval (Case B — harness gone
                                with eval/ removal)
E · production serving      ── BloomreachDataSource caching + spacing + retry
                                (Case A); no fan-out (Case B)
F · system-design templates ── three generic 9-bullet templates the codebase is
                                mapped against
```

The full per-feature breakdown is in [`agent-patterns-in-this-codebase.md`](agent-patterns-in-this-codebase.md). The companion guides this one cross-references rather than duplicates: [`../study-ai-engineering/`](../study-ai-engineering/) (single-agent + retrieval mechanics) and [`../study-system-design/`](../study-system-design/) (the systems-level view of the same orchestration).

---
Updated: 2026-05-29 — created
Updated: 2026-06-16 — Reflected Phase 2 DataSource seam (`lib/data-source/`), the authored sibling `mcp-server-olist` package and its three domain tools, the new `bi:mode = 'demo' | 'live-sql' | 'live-bloomreach'` triple, and the Phase 3 four-pillar eval suite with portfolio numbers.
Updated: 2026-06-19 — Reflected AptKit v0.3.0 migration: active spine is AptKit's agent classes (`@aptkit/core`); Blooming-owned bridge is `aptkit-adapters.ts` (3 adapters, 206 LOC); legacy spine preserved at `base-legacy.ts`. Removed Olist + mcp-server-olist + eval/ references (all deleted in PR #8 commit 62c24d7). Added `SyntheticDataSource` as the second adapter behind the surviving DataSource seam. Mode triple is now `'demo' | 'live-bloomreach' | 'live-synthetic'`. Added pointer to new `04-agent-infrastructure/06-aptkit-runtime-layer.md` concept file.

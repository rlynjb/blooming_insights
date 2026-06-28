# 00 — overview

The whole AI stack of blooming insights in one frame, then a quick tour of where
each piece lives in the repo.

## The whole system in one diagram

```
  blooming insights — AI stack, top to bottom

  ┌─ UI (browser) ─────────────────────────────────────────────────┐
  │  app/page.tsx (feed)  ·  app/investigate/[id]/page.tsx          │
  │  app/investigate/[id]/recommend/page.tsx  ·  QueryBox            │
  │       ▲                                                          │
  │       │  NDJSON stream over fetch+ReadableStream (no SSE)        │
  └───────┼──────────────────────────────────────────────────────────┘
          │
  ┌─ Edge / route handlers (Vercel, maxDuration=300s) ──────────────┐
  │  /api/briefing   → monitoring agent → insights[]                │
  │  /api/agent      → diagnostic | recommendation | query          │
  │  /api/mcp/*      → call/tools/callback/reset/capture            │
  └───────┬──────────────────────────────────────────────────────────┘
          │  AgentEvent NDJSON (encodeEvent in lib/mcp/events.ts)
          ▼
  ┌─ Agent layer (lib/agents/*) — THIN BLOOMING WRAPPERS ───────────┐
  │  MonitoringAgent · DiagnosticAgent · RecommendationAgent         │
  │  QueryAgent · classifyIntent                                     │
  │       │                                                          │
  │       ▼ each agent newAptKit*Agent({ model, tools, trace, … })  │
  │  ┌─ AptKit core (@aptkit/core@0.3.0) — OWNS THE LOOP ──────────┐│
  │  │  AnomalyMonitoringAgent · DiagnosticInvestigationAgent        ││
  │  │  RecommendationAgent · QueryAgent · classifyIntent            ││
  │  │  ECOMMERCE_ANOMALY_CATEGORIES (10)  +  schemaCapabilities()   ││
  │  └────────────────────────────────────────────────────────────────┘│
  │       ▲                          ▲                          ▲    │
  │       │ ModelProvider            │ ToolRegistry             │ TraceSink
  │       │ (Anthropic SDK)          │ (DataSource)             │ (NDJSON)
  │       │                          │                          │    │
  │  ┌─ adapters (lib/agents/aptkit-adapters.ts) ────────────────┐  │
  │  │  AnthropicModelProviderAdapter  ·  BloomingToolRegistry-   │  │
  │  │  Adapter  ·  BloomingTraceSinkAdapter (CapabilityEvent →   │  │
  │  │  Blooming AgentEvent NDJSON)                                │  │
  │  └────────────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────────────┘
          │                          │
          ▼                          ▼
  ┌─ Model provider ──────┐   ┌─ DataSource seam (lib/data-source/*) ┐
  │  api.anthropic.com    │   │  BloomreachDataSource (real MCP)     │
  │  claude-sonnet-4-6    │   │   + 60s cache + ~1 req/s + retry     │
  │  claude-haiku-4-5-…   │   │  SyntheticDataSource (local fake)    │
  │  (intent classifier)  │   │  bi:mode = demo | live-bloomreach |  │
  │                       │   │            live-synthetic            │
  └───────────────────────┘   └───────────────────┬──────────────────┘
                                                  │
                                                  ▼
                              ┌─ Bloomreach loomi connect MCP server ┐
                              │  loomi-mcp-alpha.bloomreach.com/mcp  │
                              │  OAuth/PKCE/DCR (lib/mcp/auth.ts)    │
                              │  Tools: execute_analytics_eql,       │
                              │    list_scenarios, list_segmentations,│
                              │    list_email_campaigns, …           │
                              └──────────────────────────────────────┘
```

## The five agents, in one table

  ┌─────────────────┬──────────────────────┬───────────────────────┬─────────────────────────┐
  │ Agent           │ Model                │ Tools (allowlist in)  │ Output shape            │
  ├─────────────────┼──────────────────────┼───────────────────────┼─────────────────────────┤
  │ monitoring      │ claude-sonnet-4-6    │ monitoringTools (13)  │ Anomaly[]               │
  │ diagnostic      │ claude-sonnet-4-6    │ diagnosticTools (17)  │ Diagnosis               │
  │ recommendation  │ claude-sonnet-4-6    │ recommendationTools(8)│ Recommendation[]        │
  │ query (coord.)  │ claude-sonnet-4-6    │ queryTools (union)    │ string (NL answer)      │
  │ intent          │ claude-haiku-4-5-…   │ none                  │ QueryIntent             │
  └─────────────────┴──────────────────────┴───────────────────────┴─────────────────────────┘

Allowlists live in `lib/mcp/tools.ts:1-60`. The intent classifier is the only
agent that doesn't get tools — it's a one-shot, prompt-only classifier.

## The control flow on a typical investigation

```
  feed click → /api/agent?insightId=...&step=diagnose
       │
       ▼
  resolve anomaly (insight param > in-memory > demo snapshot)
       │
       ▼
  bootstrap workspace schema  (list_cloud_organizations → list_projects →
       │                       get_event_schema → list_catalogs → …)
       ▼
  listTools (raw MCP tools)
       │
       ▼
  DiagnosticAgent.investigate(anomaly)
       │  AptKit loop: model → tool_call → result → model → …
       │  trace sink → encodeEvent → NDJSON line → res.body
       ▼
  emit { type: 'diagnosis', diagnosis }
       │
       ▼
  emit { type: 'done' }   (step 3 — recommend — is a SEPARATE route call)
```

## What's missing on purpose

| Pattern                         | Status in repo            | Where to read   |
|---------------------------------|---------------------------|------------------|
| Vector store / embeddings       | not exercised             | `03-retrieval-and-rag/` |
| Chunking strategy               | not exercised             | `03-retrieval-and-rag/` |
| RAG (semantic retrieval)        | not exercised — EQL only  | `03-retrieval-and-rag/11-rag.md` |
| Automated LLM eval harness      | not exercised             | `05-evals-and-observability/` |
| LLM-as-judge                    | not exercised             | `05-evals-and-observability/03-llm-as-judge-bias.md` |
| Prompt cache (Anthropic)        | not exercised             | `06-production-serving/01-llm-caching.md` |
| Semantic cache                  | not exercised             | `06-production-serving/01-llm-caching.md` |
| Circuit breaker (LLM provider)  | not exercised             | `06-production-serving/05-retry-circuit-breaker.md` |

Each "not exercised" item is taught in the relevant concept file as a pattern,
with a Case B `## Project exercises` block that names the concrete refactor.

## Where to start reading the code

  → `lib/agents/aptkit-adapters.ts` (206 LOC) — the AI seam. Read this first.
  → `app/api/agent/route.ts` (345 LOC) — the request → stream lifecycle.
  → `lib/agents/monitoring.ts` (117 LOC) — the simplest agent wrapper.
  → `lib/mcp/validate.ts` (58 LOC) — the lenient JSON parser + type guards.
  → `lib/data-source/bloomreach-data-source.ts` (214 LOC) — the rate-limit /
    retry / cache layer that AptKit calls through.

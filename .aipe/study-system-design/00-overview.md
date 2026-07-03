# 00-overview — the whole system on one page

Everything below is what actually runs today. No planned architecture, no aspirational boxes.

## The full-system diagram

```
  blooming insights — the full system, one frame

  ┌─ Browser (Next.js App Router client) ────────────────────────────────────┐
  │                                                                            │
  │   app/page.tsx            useBriefingStream    useInvestigation            │
  │     ├─ InsightCard        (fetch → readNdjson)  (fetch → readNdjson)      │
  │     ├─ StatusLog          + reconnect policy    + sessionStorage stash    │
  │     ├─ ProcessStepper                                                      │
  │     └─ QueryBox (hidden)  bi:mode in localStorage: demo | live-bloomreach  │
  │                                              | live-synthetic              │
  └─────┬──────────────────────────────────────────────────┬──────────────────┘
        │  GET /api/briefing?mode=…                        │  GET /api/agent?…
        │  NDJSON stream                                   │  NDJSON stream
        ▼                                                  ▼
  ┌─ Vercel serverless (maxDuration = 300) ─────────────────────────────────┐
  │                                                                          │
  │   app/api/briefing/route.ts          app/api/agent/route.ts              │
  │     ├─ demo?  → replay demo-insights.json (creds-free NDJSON)            │
  │     ├─ live? → makeDataSource(mode, sid)                                 │
  │     │           ├─ live-bloomreach → BloomreachDataSource (OAuth)        │
  │     │           └─ live-synthetic  → SyntheticDataSource (in-process)    │
  │     ├─ bootstrap → WorkspaceSchema                                       │
  │     └─ MonitoringAgent | DiagnosticAgent | RecommendationAgent | Query   │
  │            ▼                                                              │
  │        ┌─ @aptkit/core (provider-neutral primitives) ───────────────┐    │
  │        │  ModelProvider  ← AnthropicModelProviderAdapter            │    │
  │        │  ToolRegistry   ← BloomingToolRegistryAdapter              │    │
  │        │  TraceSink      ← BloomingTraceSinkAdapter                 │    │
  │        │                    + BudgetTracker ceiling gate            │    │
  │        │                    + onCapabilityEvent forwarding          │    │
  │        └───────────────────────────────────────────────────────────┘    │
  │              │                       │                                    │
  └──────────────┼───────────────────────┼───────────────────────────────────┘
                 │ HTTPS                 │ HTTPS
                 ▼                       ▼
        ┌─ Anthropic API ─┐    ┌─ Bloomreach loomi connect MCP ─┐
        │  claude-sonnet  │    │  StreamableHTTPClientTransport │
        │  -4-6 (agents)  │    │  + PKCE + DCR                  │
        │  claude-haiku   │    │  ~1 req/s spacing              │
        │  -4-5 (intent)  │    │  retry ladder on rate-limit    │
        └─────────────────┘    └────────────────────────────────┘

  ── offline (never in the request path) ──────────────────────────────────
  eval/  goldens + rubrics + judge + baseline.json + regression gate
         wraps SyntheticDataSource in FaultInjectingDataSource for load runs
         → CI (.github/workflows/ci.yml) typechecks + tests + builds
```

## Legend — what each box is, what it owns, what it talks to

**Browser (Next.js App Router client)** — the marketer-facing surface. Owns runtime toggle state (`bi:mode` in localStorage), the reconnect policy for token-revoke recovery, and per-investigation stashes in sessionStorage so back-nav hydrates instantly. Talks only to its own `/api/*` routes; never to Anthropic or Bloomreach directly (API keys stay server-side).

**app/api/briefing/route.ts** — one endpoint, three code paths: demo replay, live-Bloomreach, live-synthetic. Owns the NDJSON stream contract, the coverage-gate narration, and the per-phase timing log. Composes the DataSource factory with the `MonitoringAgent`.

**app/api/agent/route.ts** — one endpoint, four code paths: cached replay, free-form query, diagnose step, recommend step. Owns the anomaly-resolution fallback chain (client → in-memory → demo snapshot) and step-filtered replay. Composes the DataSource factory with `DiagnosticAgent` + `RecommendationAgent` + `QueryAgent`.

**makeDataSource factory** (`lib/data-source/index.ts`) — the injection point. Branches on `LiveMode`, returns `{ dataSource, bootstrap, dispose }`. Routes hold the abstract `DataSource` type, never the concrete adapter.

**BloomreachDataSource** (`lib/data-source/bloomreach-data-source.ts`, 214 LOC) — the live adapter. Wraps the connected MCP transport with ~1 req/s spacing, rate-limit retry, 60s response cache, and abort composition. Owns the OAuth session (via `lib/mcp/auth.ts`).

**SyntheticDataSource** (`lib/data-source/synthetic-data-source.ts`, 516 LOC) — the in-process adapter. Deterministic fake data; no network. Used by the `live-synthetic` mode AND by every eval run. Ships with a matching `syntheticWorkspaceSchema` so `bootstrap()` skips the orchestrator.

**FaultInjectingDataSource** (`lib/data-source/fault-injecting.ts`, 167 LOC) — a *decorator*, not a swap. Wraps any `DataSource` with configurable failure rates (timeout / rate-limit / server-error / malformed-JSON). Offline only — the load harness uses it; production never sees it.

**@aptkit/core primitives** (`node_modules/@aptkit/core`, v0.3.0) — the provider-neutral vocabulary Blooming's agents run on. `ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`. All three are ports; Blooming's `lib/agents/aptkit-adapters.ts` (263 LOC) is the three-class bridge.

**BudgetTracker** (`lib/agents/budget.ts`) — a cross-cutting ceiling. Created once per investigation, threaded through `AgentHooks` into `AnthropicModelProviderAdapter`, checked *before* every `messages.create` dispatch. Throws `BudgetExceededError` on the next turn if the accumulated spend has passed the limit.

**Session-keyed insights** (`lib/state/insights.ts`) — an outer `Map<sessionId, SessionFeed>`. Each session gets its own `insights` / `investigations` / `anomalies` sub-maps. `putInsights` only clears the *inner* maps; the outer map survives so a warm serverless instance can serve concurrent users without one briefing wiping another. No database.

**demo replay** (`lib/state/demo-*.json`) — committed snapshots. Serve as instant-loading canonical presentations, and as the fallback resolution for `resolveAnomaly` in `/api/agent`. The demo path never touches Anthropic or Bloomreach.

**eval harness** (`eval/`) — offline tier-2 hardening. Ten goldens, two rubrics (diagnosis + recommendation), judge → receipts → baseline → regression gate. Wraps `SyntheticDataSource` in `FaultInjectingDataSource` for load runs. Never runs in `npm test`; runs in `npm run eval:*` and (as a gate) in CI.

**CI** (`.github/workflows/ci.yml`) — typecheck + unit/integration tests + build on every push and PR. Eval + gate wire up separately (documented, not yet on the required-checks list).

# Overview — blooming_insights system map

The one-page map. If you read only one file in this folder, read this one.

## The whole system in one diagram

```
  blooming_insights — end-to-end system map

  ┌─ UI (browser) ───────────────────────────────────────────────────────────┐
  │  app/page.tsx          investigate/[id]/page.tsx    recommend/page.tsx    │
  │     │                            │                          │             │
  │     │ uses                       │ uses                     │ uses        │
  │     ▼                            ▼                          ▼             │
  │  useBriefingStream         useInvestigation           useInvestigation     │
  │  (313 LOC)                 (202 LOC)                  (same hook)          │
  │     │                            │                          │             │
  │     └──── fetch + readNdjson ────┴──────────────────────────┘             │
  │                            │  (one kernel — lib/streaming/ndjson.ts 64L)  │
  └────────────────────────────┼─────────────────────────────────────────────┘
                               │  HTTP — content-type: application/x-ndjson
                               │  events: AgentEvent + briefing-only variants
  ┌─ Next.js routes ──────────▼─────────────────────────────────────────────┐
  │  app/api/briefing/route.ts        app/api/agent/route.ts                 │
  │  (336 LOC, maxDuration=300)       (345 LOC, maxDuration=300)              │
  │     │                                       │                            │
  │     │ getOrCreateSessionId() ──────────────┴──────────► bi_session cookie│
  │     │                                       │                            │
  │     ▼                                       ▼                            │
  │  makeDataSource(mode, sessionId)  ◄── factory (lib/data-source/index.ts) │
  │     │                                                                    │
  │     │ branches on ?mode= : 'live-bloomreach' | 'live-synthetic'         │
  └─────┼────────────────────────────────────────────────────────────────────┘
        │
        │  THE LOAD-BEARING SEAM
        │  port: `DataSource` (lib/data-source/types.ts) — `callTool`, `listTools`
        │  envelope: { result, durationMs, fromCache }
        ▼
  ┌─ Adapters behind the seam ──────────────────────────────────────────────┐
  │  ┌──────────────────────────────┐   ┌─────────────────────────────────┐ │
  │  │ BloomreachDataSource         │   │ SyntheticDataSource             │ │
  │  │ (214 LOC, HTTPS over MCP)    │   │ (516 LOC, in-process fixtures)  │ │
  │  │  • OAuth/PKCE/DCR session    │   │  • deterministic fake data       │ │
  │  │  • 1.1s spacing, retry ladder│   │  • real agent loop, no network   │ │
  │  │  • 60s response cache        │   │                                  │ │
  │  └──────────────┬───────────────┘   └─────────────────────────────────┘ │
  └─────────────────┼────────────────────────────────────────────────────────┘
                    │  HTTPS (StreamableHTTPClientTransport)
                    ▼
  ┌─ External provider ────────────────────────────────────────────────────┐
  │  loomi-mcp-alpha.bloomreach.com/mcp   (Bloomreach Engagement workspace) │
  │  rate-limited ~1 req/s, alpha-grade auth (revokes tokens after minutes) │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ Agent runtime (sits beside the routes) ───────────────────────────────┐
  │  MonitoringAgent / DiagnosticAgent / RecommendationAgent / QueryAgent  │
  │      │  each is a ~50-line wrapper over @aptkit/core agents             │
  │      ▼                                                                  │
  │  AptKit primitive (the agent loop, library-owned)                       │
  │      ├─ ModelProvider   ◄── AnthropicModelProviderAdapter (this repo)   │
  │      ├─ ToolRegistry    ◄── BloomingToolRegistryAdapter   (this repo)   │
  │      └─ CapabilityTraceSink ◄── BloomingTraceSinkAdapter  (this repo)   │
  │           │                                                             │
  │           └── emits onToolCall / onToolResult / onText hooks            │
  │               which the route turns into NDJSON events on the wire      │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ Server state (process memory) ────────────────────────────────────────┐
  │  lib/state/insights.ts        Map<sessionId, SessionFeed>               │
  │  lib/state/investigations.ts  (committed demo-*.json fallbacks)         │
  └────────────────────────────────────────────────────────────────────────┘
```

## Legend — what each component is, owns, and talks to

The map above has nine layers. Here's what each one is responsible for.

### UI (browser)

| Component | What it owns | Talks to |
|-----------|--------------|----------|
| `app/page.tsx` (461 LOC) | the feed page — mode toggle, header, two-column layout, query box | `useBriefingStream`, `useDemoCapture`, `useReconnectPolicy` |
| `app/investigate/[id]/page.tsx` | the diagnostic step page | `useInvestigation` (step=diagnose) |
| `app/investigate/[id]/recommend/page.tsx` | the recommendation step page | `useInvestigation` (step=recommend) |
| `useBriefingStream` (313 LOC) | the `/api/briefing` fetch + the 9-case NDJSON dispatcher | `readNdjson`, callbacks into the reconnect policy |
| `useInvestigation` (202 LOC) | the `/api/agent` fetch + the per-step replay + `sessionStorage` stash | `readNdjson` |
| `useDemoCapture` (146 LOC) | dev-only one-click "capture this as the demo snapshot" | `/api/mcp/capture-demo` |
| `useReconnectPolicy` (123 LOC) | the auto-reconnect dance for revoked Bloomreach tokens | `/api/mcp/reset`, full page reload |

### Streaming kernel

`lib/streaming/ndjson.ts` (64 LOC) — one `readNdjson` function. Consumed by four streaming surfaces (briefing, investigation, capture, query). Producers always terminate with `\n`; the kernel flushes the trailing buffer at end-of-stream, polls a `cancelOn` predicate between reads, and silently skips malformed lines.

### Next.js routes

| Route | What it owns | Notes |
|-------|--------------|-------|
| `app/api/briefing/route.ts` (336 LOC) | the monitoring scan: schema → coverage gate → MonitoringAgent → insights | `maxDuration = 300` (Vercel Pro), NDJSON response, demo branch replays `lib/state/demo-insights.json` |
| `app/api/agent/route.ts` (345 LOC) | per-step investigation: diagnose or recommend, with the diagnosis handed forward | `maxDuration = 300`, NDJSON, demo branch replays `demo-investigations.json` filtered per step |
| `app/api/mcp/{call,callback,reset,tools,tools/check,capture,capture-demo}/` | the short OAuth + dev tooling routes — direct Bloomreach adapter usage (skipCache is Bloomreach-specific) | not on the user's hot path |

### Factory + DataSource seam

The interface `DataSource` (the port) is in `lib/data-source/types.ts`. The factory `makeDataSource` (`lib/data-source/index.ts`) takes `(mode, sessionId)` and returns a connected adapter plus a `bootstrap(signal)` callback and a `dispose()`. The routes only see the abstract surface; they never construct a concrete adapter.

### Adapters

Two adapters live behind the seam today:

- **`BloomreachDataSource`** (`lib/data-source/bloomreach-data-source.ts`, 214 LOC) — wraps a connected `StreamableHTTPClientTransport`, carries OAuth/PKCE/DCR session, 1.1s proactive spacing, rate-limit retry ladder, 60s response cache.
- **`SyntheticDataSource`** (`lib/data-source/synthetic-data-source.ts`, 516 LOC) — deterministic in-process fixtures. Lets the real agent loop run end-to-end against fake data, no network.

Historical note: an Olist (SQL) adapter lived behind this seam during Phase 2 and was removed in PR #8 (commit `62c24d7`, 2026-06-18); the `eval/` harness was retired the same week. Two adapter swaps later, the seam's caller surface still hasn't changed.

### External provider

`https://loomi-mcp-alpha.bloomreach.com/mcp` — the Bloomreach Engagement workspace under analysis. Alpha-grade: per-user global rate limit of ~1 req/s, OAuth tokens revoked after minutes. Every reliability mechanic in `BloomreachDataSource` and `useReconnectPolicy` exists because of these two facts.

### Agent runtime

The agent loop itself lives in `@aptkit/core@0.3.0` — the library owns the loop, this repo owns the boundary. Three adapter classes in `lib/agents/aptkit-adapters.ts` (206 LOC) bind the library to this repo's primitives:

| Adapter | Library port | This repo's adapter | Bridges to |
|---------|--------------|---------------------|------------|
| Model provider | `ModelProvider` | `AnthropicModelProviderAdapter` | the `@anthropic-ai/sdk` client (`claude-sonnet-4-6`) |
| Tool registry | `ToolRegistry` | `BloomingToolRegistryAdapter` | the `DataSource` port (above) |
| Trace sink | `CapabilityTraceSink` | `BloomingTraceSinkAdapter` | this repo's `onToolCall` / `onToolResult` / `onText` hooks → NDJSON events |

The five active agent files (`monitoring.ts`, `diagnostic.ts`, `recommendation.ts`, `query.ts`, `intent.ts`) are thin wrappers — they construct the adapters and call `agent.scan(…)` or `agent.run(…)`. The legacy hand-rolled loop is preserved at `lib/agents/base-legacy.ts:86-176` as a rollback receipt.

### Server state (process memory)

There is no database. State is a `Map<sessionId, SessionFeed>` in `lib/state/insights.ts` — keyed by the session cookie so a warm Vercel instance serving multiple users doesn't bleed feeds. The concurrent-user wipe bug (where `putInsights().clear()` would erase another user's data) is resolved by the per-session keying. Demo snapshots (`lib/state/demo-*.json`) are the durable fallback.

## The load-bearing finding

If you remember one thing from this map: **the `DataSource` port is the seam that earned its keep.** It's the only abstraction in this repo that has been swapped twice (Olist added Phase 2, then removed in PR #8; Synthetic added) without changing a caller. Every other component takes a `DataSource` and asks no questions. That's why `03-datasource-seam.md` is the canonical port/adapter teaching file in this folder.

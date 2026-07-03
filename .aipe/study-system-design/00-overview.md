# 00 — Overview

The whole system, one page. Read this and you can place every pattern
file that follows on the map.

## The system

```
  blooming insights — full-system map (Next.js 16 SPA, streaming NDJSON)

  ┌─ Browser (single-page app) ────────────────────────────────────────────┐
  │                                                                        │
  │  ┌ Feed (app/page.tsx) ────────┐    ┌ Investigate (app/investigate)    │
  │  │  InsightCard × N            │    │   step 2: EvidencePanel          │
  │  │  StatusLog (streaming)      │    │   step 3: RecommendationCard     │
  │  │  ProcessStepper             │    │   StatusLog (streaming)          │
  │  │  QueryBox                   │    └──────────────────────────────────┘
  │  │  McpConfigModal (settings)  │                                        │
  │  └──────┬──────────────────────┘                                        │
  │         │ mode = bi:mode (localStorage)   ── demo | live-mcp |          │
  │         │                                    live-synthetic             │
  │         │ mcp override = bi:mcp_config (localStorage) → base64 header   │
  │         │ (BI_MCP_CONFIG_HEADER = 'x-bi-mcp-config')                    │
  │         ▼                                                               │
  │  fetch()  ──── NDJSON stream (application/x-ndjson) ────────────────►   │
  │  useBriefingStream / useInvestigation / readNdjson kernel               │
  └──────────────────────────┬─────────────────────────────────────────────┘
                             │  HTTPS · session cookie · config header
  ┌─ Next.js 16 API routes (Vercel Node runtime, maxDuration 300) ─────────┐
  │                                                                        │
  │  /api/briefing         monitoring scan → NDJSON insight events         │
  │  /api/agent            investigation (diagnose · recommend · query)    │
  │  /api/mcp/{callback,   OAuth callback · session reset · one-off tool   │
  │           reset,call,  calls · tools list · coverage check · capture   │
  │           tools,capture}                                               │
  │                                                                        │
  │  each route:                                                           │
  │    1. parseLiveMode(?mode=)  →  'demo' | 'live-mcp' | 'live-synthetic' │
  │    2. decodeConfigHeader(x-bi-mcp-config)  →  McpConfigOverride | null │
  │    3. makeDataSource(mode, sid, override)                              │
  │    4. stream AgentEvents back                                          │
  └──────────────────────────┬─────────────────────────────────────────────┘
                             │
  ┌─ DataSource factory (lib/data-source/index.ts) ────────────────────────┐
  │                                                                        │
  │      mode = demo         ─── never gets here; served from committed    │
  │                              snapshot by route (JSON, no factory)      │
  │      mode = live-mcp     ─── connectMcp(sid, override) → McpDataSource │
  │      mode = live-synthetic ── new SyntheticDataSource()                │
  │                                                                        │
  │  wrapping (offline-only): FaultInjectingDataSource                     │
  └───────┬────────────────────────────────┬──────────────────────────────┘
          │                                │
  ┌─ Auth strategy (lib/mcp/auth-providers) │                              │
  │    Bloomreach (OAuth 2.1 + PKCE + DCR)  │                              │
  │    Bearer     (Authorization: Bearer …) │                              │
  │    Anonymous  (no auth header)          │                              │
  │  precedence:                            │                              │
  │    override.authType → MCP_AUTH_TYPE →  │                              │
  │    default 'oauth-bloomreach'           │                              │
  └──────────────────┬──────────────────────┘                              │
                     │                                                     │
  ┌─ Agents (bridge into @aptkit/core@0.3.0) ─────────────────────────────┐│
  │  lib/agents/*.ts + lib/agents/aptkit-adapters.ts (263 LOC · 3 classes)││
  │    monitoring · diagnostic · recommendation · query                   ││
  │    classifyIntent (Haiku, cheap classifier)                           ││
  │                                                                       ││
  │  adapters:                                                            ││
  │    AnthropicModelProviderAdapter  →  Anthropic SDK                    ││
  │    BloomingToolRegistryAdapter    →  DataSource.callTool              ││
  │    BloomingTraceSinkAdapter       →  onText/onToolCall/onCapability   ││
  │                                                                       ││
  │  BudgetTracker (per-investigation) → BudgetExceededError → NDJSON err ││
  └─────────────────┬─────────────────────────────────────────────────────┘│
                    │                                                      │
                    ▼                                                      ▼
  ┌─ MCP server (whatever URL the config resolves to) ────────────────────┐
  │  default preset:  https://loomi-mcp-alpha.bloomreach.com/mcp          │
  │  rate limit:      ~1 req/s per user (global), 429 with hint           │
  │  session:         OAuth tokens revoked after minutes → auto-reconnect │
  │  trust:           the config target sees every tool call + args       │
  └───────────────────────────────────────────────────────────────────────┘
```

## Legend

- **`ProcessStepper`** — the 3-step navigation shown on every page.
  Monitoring → Investigation → Decision. Steps are clickable links;
  current step stays `active` (never marked ✓).
- **`InsightCard`** — `components/feed/InsightCard.tsx`. Renders one
  `Anomaly` as a card with headline, summary, why-it-matters, scope,
  prior→now comparison, and `via <tool>` provenance.
- **`StatusLog`** — `components/shared/StatusLog.tsx`. The sticky
  sidebar streaming reasoning steps + tool calls as they happen.
  Rides the shared `readNdjson` kernel.
- **`useBriefingStream`** — `lib/hooks/useBriefingStream.ts`. The
  feed's data hook. Chooses the mode branch (demo replays committed
  JSON; live-mcp / live-synthetic streams NDJSON from `/api/briefing`).
- **`useInvestigation`** — `lib/hooks/useInvestigation.ts`. Runs one
  investigation step, streams the trace, stashes the result in
  `sessionStorage` so step 3 hydrates instantly.
- **`McpConfigModal`** — `components/settings/McpConfigModal.tsx`
  (~300 LOC). The UI settings modal that persists the per-request
  MCP config override to localStorage.
- **`makeDataSource`** — `lib/data-source/index.ts:84`. The factory.
  Routes never construct a concrete adapter directly.
- **`connectMcp`** — `lib/mcp/connect.ts:82`. Owns the MCP transport
  handshake + the auth-provider selection (`buildAuthProvider`).
- **`McpDataSource`** — `lib/data-source/mcp-data-source.ts` (re-
  exports `BloomreachDataSource` — same class, renamed for clarity).
  The MCP client the `live-mcp` mode uses. Bloomreach is one preset;
  the class itself is generic.
- **`SyntheticDataSource`** — `lib/data-source/synthetic-data-source.ts`.
  Blooming-owned deterministic fake data. Same tool catalog shape as
  the MCP path; the agents can't tell the difference.
- **`FaultInjectingDataSource`** — `lib/data-source/fault-injecting.ts`.
  Offline decorator that forces timeout / 429 / 500 / malformed-JSON
  faults at configurable rates.
- **AuthProviders** — three implementations of the MCP SDK's
  `OAuthClientProvider` interface. Bloomreach OAuth (2.1 + PKCE +
  DCR) is the default preset; bearer + anonymous are for other MCP
  servers.
- **`AgentEvent`** — `lib/mcp/events.ts`. The NDJSON discriminated
  union every route producer emits and every UI consumer parses.
- **`BudgetTracker`** — `lib/agents/budget.ts`. Per-investigation
  cost ceiling. Gates before every model turn.
- **AptKit primitives** — `@aptkit/core@0.3.0`. The reusable ReAct
  agent loop, tool registry surface, capability trace. The three
  adapters in `lib/agents/aptkit-adapters.ts` are the boundary
  between this repo's specifics and the reusable primitive.

## What each layer owns

- **Browser** owns UI state, `bi:mode`, `bi:mcp_config`, and the
  `sessionStorage`-cached investigation result.
- **Routes** own request-scoped concerns: session cookies, the mode
  branch, the config header decode, the NDJSON producer loop, the
  route-level abort signal.
- **DataSource factory** owns adapter selection and the connect
  handshake.
- **Adapters** (agent / registry / trace) own the translation
  between AptKit's provider-neutral vocabulary and this repo's
  Anthropic SDK + Blooming-specific tool defs.
- **AuthProviders** own only the auth header on each MCP request.
- **MCP server** (whatever URL is configured) owns the workspace
  data, the rate limit, and the tokens.

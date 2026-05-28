# blooming insights — system map

```
┌─ UI layer (Next.js App Router, React 19, client components) ───────────────────┐
│                                                                                │
│   app/page.tsx                 app/investigate/[id]/page.tsx     QueryBox       │
│   (feed: insight cards)        (streaming reasoning trace)       (ask box)      │
│        │  fetch /api/briefing        │  fetch /api/agent?insightId   │ ?q=      │
│        │  (or ?demo=cached)          │  (NDJSON reader loop)         │          │
└────────│─────────────────────────────│──────────────────────────────│──────────┘
         │                             │                              │
         ▼      Network boundary (HTTP / chunked NDJSON stream)       ▼
┌─ Route / Service layer (Next route handlers, maxDuration 60) ──────────────────┐
│                                                                                │
│   /api/briefing            /api/agent (NDJSON stream)        /api/mcp/*         │
│   monitoring → insights    cache-replay │ live: diagnostic   callback · call ·  │
│        │                   → recommendation, save investn    tools · capture    │
│        ▼                             │                              │           │
│   ┌──────────────────────────────────────────────────────────────────────┐    │
│   │ lib/agents/base.ts  runAgentLoop  (shared Claude tool-use loop)        │    │
│   │   ▲ monitoring  ▲ diagnostic  ▲ recommendation  ▲ query                │    │
│   │   each = prompt + tool subset + validator + dedicated synthesis        │    │
│   └───────────────────────────────────┬──────────────────────────────────┘    │
│        │ Anthropic SDK (claude-sonnet-4-6)│ McpClient.callTool                  │
│        ▼                                  ▼                                      │
│   ┌─ Provider/abstraction seam ─────────────────────────────────────────┐      │
│   │ lib/mcp/client.ts  McpClient  (cache + rate-limit + retry)           │      │
│   │ lib/mcp/transport.ts  McpTransport ⇠ SdkTransport (+ fakes in tests) │      │
│   │ lib/mcp/connect.ts  connectMcp / completeAuth                        │      │
│   │ lib/mcp/auth.ts  BloomreachAuthProvider (OAuth PKCE + DCR)           │      │
│   └───────────────────────────────────┬─────────────────────────────────┘      │
└────────────────────────────────────────│───────────────────────────────────────┘
         │ state (no DB)                  ▼  Provider layer (network)
┌─ State ──────────────────┐   ┌─ External providers ──────────────────────────┐
│ lib/state/insights.ts    │   │  Bloomreach loomi connect MCP                  │
│ lib/state/investigations │   │  (StreamableHTTPClientTransport, ~1 req/s/user)│
│ in-memory + dev files +  │   │  Anthropic API (agent reasoning)               │
│ committed demo-*.json    │   └────────────────────────────────────────────────┘
└──────────────────────────┘
```

## Legend

- **app/page.tsx** — the feed (morning briefing). Fetches `/api/briefing`; renders `InsightCard`s; hosts the query box. → `/api/briefing`, `/api/agent?q=`.
- **app/investigate/[id]/page.tsx** — the streaming investigation view. Reads `/api/agent`'s NDJSON via a `fetch` reader loop; renders the reasoning trace + diagnosis + recommendations. → `/api/agent?insightId=`.
- **QueryBox / StreamingResponse** — free-form question box + its streamed answer. → `/api/agent?q=`.
- **/api/briefing** — runs the monitoring agent and returns insights (or a cached snapshot on `?demo=cached`). → `connectMcp`, `bootstrapSchema`, `MonitoringAgent`, `lib/state/insights`.
- **/api/agent** — NDJSON stream: replays a cached investigation, or runs diagnostic → recommendation live and saves the result. Also serves `?q=` queries. → `runAgentLoop`, `lib/state/investigations`.
- **/api/mcp/\*** — OAuth callback, the `/debug` tool caller, `listTools`, and the dev fixture/investigation capture. → `connectMcp`, `auth.ts`.
- **lib/agents/base.ts `runAgentLoop`** — the one Claude+MCP tool-use loop all four agents share. Bounded by `maxToolCalls`; forces a final synthesis turn. → Anthropic SDK, `McpClient`.
- **monitoring / diagnostic / recommendation / query agents** — each is a prompt + a tool subset + an output validator + (diagnostic/recommendation) a dedicated synthesis call. → `runAgentLoop`, `lib/mcp/validate`.
- **lib/mcp/client.ts `McpClient`** — the single MCP choke-point: TTL cache, ~1.1s inter-call spacing, bounded rate-limit retry, no-cache-on-error. → `McpTransport`.
- **lib/mcp/transport.ts** — `McpTransport` interface + `SdkTransport` (wraps the SDK `Client`); the injectable seam tests fake. → MCP SDK.
- **lib/mcp/connect.ts** — `connectMcp(sessionId)` (build transport + provider, connect, capture authorize URL on failure) and `completeAuth(code)`. → `auth.ts`, MCP SDK.
- **lib/mcp/auth.ts `BloomreachAuthProvider`** — implements the SDK's `OAuthClientProvider` (PKCE + Dynamic Client Registration); session-keyed store (dev: file-backed). → MCP SDK auth flow.
- **lib/state/insights.ts / investigations.ts** — in-memory maps; dev file caches; committed `demo-insights.json` / `demo-investigations.json` for the creds-free demo. → routes.
- **Bloomreach loomi connect MCP** — the data source; every tool call carries `project_id`; ~1 req/sec/user global limit. → via `StreamableHTTPClientTransport`.
- **Anthropic API** — the reasoning engine for every agent. → via `@anthropic-ai/sdk`.

## Sections

- **[01-system-design/](01-system-design/README.md)** — request flow, OAuth boundary, provider/transport abstraction, caching + rate-limiting, NDJSON streaming, multi-agent orchestration.
- **[02-dsa/](02-dsa/README.md)** — TTL cache, rate-limit spacing + retry, NDJSON line-buffering, JSON-from-prose extraction, rank-mapped sort + set union.

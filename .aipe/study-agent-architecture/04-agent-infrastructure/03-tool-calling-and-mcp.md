# Tool calling and MCP

*Industry names: tool calling / function calling / MCP (Model Context Protocol) · Industry standard*

## Zoom out

```
  Zoom out — MCP is the substrate every pattern in this guide runs on

  ┌─ SECTION A patterns  ─────────────────────────┐
  │  ReAct, plan-and-execute, reflexion, …         │
  │  → each dispatches tool calls                  │
  └─────────────────────┬─────────────────────────┘
                        ▼
  ┌─ ★ TOOL CALLING + MCP ★ ──────────────────────┐ ← we are here
  │  the protocol that standardizes agent ↔ tool   │
  └────────────────────────────────────────────────┘
```

## Zoom in

Tool calling is the connective tissue under every pattern in this guide. Covered mechanically in `.aipe/study-ai-engineering/`'s tool-calling file. This file's job: place tool calling as the substrate that ReAct, agentic RAG, and every multi-agent topology run on, and cover MCP as the protocol that standardizes how agents connect to tools and data — so a tool defined once is usable across agents without per-agent integration.

## Structure pass

Layers: **agent** — **tool definition (name + schema + description)** — **transport (MCP)** — **provider (the actual tool server)**.

Axis to hold constant: **who defines the tool contract?**

```
  Tool integration options — where the contract lives

  Direct tool definitions:    inline TS/Py in the agent code
                              contract = code

  MCP:                        server exposes tools via protocol
                              contract = MCP spec (name, schema,
                                         description discovered
                                         at runtime)

  Tool gateway:               proxy standardizes many providers
                              contract = gateway's abstraction
```

## How it works

### Move 1 — the shape

You've written an OpenAPI spec before — the contract lives outside any specific client. MCP is that shape for LLM tool integration: the tool server exposes tools with typed schemas, any agent can discover and call them at runtime, and swapping providers means swapping the URL + auth.

```
  MCP — tools discovered at runtime, contract lives in the protocol

  agent
    │  listTools()   ← discover: name, description, inputSchema
    ▼
  ┌───────────────────────────────────┐
  │  MCP server                       │
  │  (Bloomreach loomi connect,       │
  │   or a bearer-token server,       │
  │   or an anonymous local server)   │
  └───────────────────────────────────┘
    │  callTool(name, args)  ← execute: get back CallToolResult
    ▼
  provider (Bloomreach Engagement, etc.)
```

### Move 2 — how MCP is instantiated in this repo

**MCP as the tool substrate.** This repo uses MCP for every tool. There is no direct-inline tool definition. Every tool the agents call — `execute_analytics_eql`, `get_event_schema`, `list_scenarios`, `get_segment_definitions`, etc. — is discovered from the MCP server via `listTools()` and dispatched via `callTool()`.

**Two moves that make MCP swappable in this repo.**

1. **AuthProvider abstraction.** `lib/mcp/auth-providers/index.ts` exposes `makeAuthProvider({type, ...})` — a factory over three concrete implementations:

```
  AuthProvider factory — three implementations

  ┌── makeAuthProvider({ type: 'oauth-bloomreach', sessionId, redirectUri })
  │     → BloomreachAuthProvider (OAuth 2.1 + PKCE + DCR)
  │       Default preset — production Bloomreach loomi connect
  │
  ├── makeAuthProvider({ type: 'bearer', bearerToken })
  │     → BearerAuthProvider (Authorization: Bearer TOKEN)
  │       For personal access tokens / API keys
  │
  └── makeAuthProvider({ type: 'anonymous' })
      → AnonymousAuthProvider (no auth header)
        For local dev tools / public MCP servers
```

Each implements the `OAuthClientProvider` interface from `@modelcontextprotocol/sdk`. The transport talks to the SDK; the SDK talks to whichever provider was picked. Bloomreach is the default preset; the other two ship as first-class alternatives.

2. **Per-request UI config override.** `lib/mcp/config.ts` defines the `McpConfigOverride` shape (`{ url, authType, bearerToken }`) and the `x-bi-mcp-config` header. Client hooks (`useBriefingStream`, `useInvestigation`) base64-encode the current config and attach it to every streaming fetch. The route decodes it and passes it to `makeDataSource(mode, sid, override)`. A visitor can plug their own MCP server via a settings modal without changing env or forking.

**Trace of one tool call — end-to-end.**

```
  A single execute_analytics_eql call, end-to-end

  DiagnosticAgent decides on next EQL
    │
    ▼
  aptkit emits tool_use block: { name: 'execute_analytics_eql', args }
    │
    ▼
  BloomingToolRegistryAdapter.executeToolCall(name, args, signal)
    │
    ▼
  dataSource.callTool(name, args, { signal })
    │
    ▼
  BloomreachDataSource (McpDataSource):
    - check TTL cache
    - apply ~1 req/s spacing
    - dispatch via SDK transport
      │
      ▼
    SDK transport (with makeAuthProvider result attached)
      │
      ▼
    Bloomreach loomi connect MCP server
      │
      ▼
    workspace: runs EQL, returns { content, structuredContent, ... }
    ← comes back through the same chain
    ← rate-limit retry on 429 (with parsed retry-after)
    ← wrap in CallToolResult { result, durationMs, fromCache }
    │
    ▼
  BloomingToolRegistryAdapter wraps as aptkit tool_result
    │
    ▼
  aptkit appends tool_result to conversation, next turn dispatches
```

Every hop is real code. Every hop is instrumented — `hooks.onToolCall` fires when the call starts, `hooks.onToolResult` fires when it comes back. Those hooks feed the UI's StatusLog and the trace capture.

**The MCP tool call: token overhead tradeoff.** MCP tool definitions are richer than direct definitions — they carry schema, description, and the JSON envelope. That richer definition costs tokens on every listTools payload, which the model consumes as part of its context. For 12 tools, ~2-3KB overhead. For 50+ tools, this becomes worth optimizing: a **pre-router** that narrows the tool set (see `01-reasoning-patterns/07-routing.md`).

**MCP vs direct tool definitions vs a tool gateway.**

```
  Three ways to integrate tools

  Direct inline:   simplest to prototype
                   → agent-specific, no swap
                   → contract lives in code

  MCP:             swappable across agents
                   → protocol-level contract
                   → this repo

  Tool gateway:    proxy layer over many providers
                   → adds latency, adds ops
                   → useful at 10+ backend integrations
```

For this repo, MCP is the correct pick: one Bloomreach backend today, but the protocol makes it easy to swap providers or add local MCP servers (dev / testing / mock).

### Move 3 — the principle

Tool calling is the substrate every reasoning pattern in this guide runs on. MCP standardizes the tool contract at the protocol level, so a tool defined once is usable across agents without per-agent integration. The AuthProvider abstraction turns "which MCP server" into a swappable dependency — production Bloomreach today, but a bearer-auth or anonymous server tomorrow with one env var (or one settings-modal click).

## Primary diagram

```
  MCP in this repo — the substrate + the swappable pieces

  ┌─ Agents (aptkit ReAct loops) ─────────────────────────────┐
  │  Monitoring · Diagnostic · Recommendation · Query          │
  └─────────────────────┬─────────────────────────────────────┘
                        │ BloomingToolRegistryAdapter
                        ▼
  ┌─ DataSource seam (port) ──────────────────────────────────┐
  │  callTool / listTools                                     │
  └─────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
  ┌─ BloomreachDataSource (McpDataSource — MCP client) ───────┐
  │  60s TTL cache + ~1 req/s spacing + retry ladder          │
  │  AbortSignal composition + McpToolError                   │
  └─────────────────────┬─────────────────────────────────────┘
                        │ MCP SDK transport
                        ▼
  ┌─ AuthProvider (swappable) ────────────────────────────────┐
  │  makeAuthProvider({ type, sessionId, redirectUri, ... })  │
  │  ├─ BloomreachAuthProvider  (OAuth PKCE DCR, default)     │
  │  ├─ BearerAuthProvider      (Authorization: Bearer TOKEN) │
  │  └─ AnonymousAuthProvider   (no auth header)              │
  └─────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
  ┌─ MCP server ───────────────────────────────────────────────┐
  │  default: Bloomreach loomi connect                         │
  │  OR: any MCP-compliant server (env or UI-config override)  │
  └─────────────────────┬─────────────────────────────────────┘
                        ▼
              provider (Bloomreach Engagement, etc.)

  Per-request UI override:
    browser → x-bi-mcp-config header (base64 JSON) → route decodes
    → makeDataSource(mode, sid, override) picks the right AuthProvider
```

## Elaborate

MCP (Model Context Protocol) was released by Anthropic in November 2024 as an open standard for connecting LLMs to external tools and data. The design goal was exactly this repo's shape: a protocol-level contract that decouples "the agent" from "the tool provider." Before MCP, every framework had its own tool interface (LangChain tools, OpenAI functions, Anthropic tools); MCP is the first shot at a cross-framework standard.

The interesting adoption pattern is the **MCP server marketplace** — servers for Postgres, Slack, GitHub, filesystem, browser control — that any MCP-aware agent can consume. The protocol lets you build "the agent" once and add tools by pointing at new servers, no code changes to the agent. That's the same DI-shaped pattern this repo's AuthProvider abstraction implements at the auth layer.

The token overhead of MCP-style rich tool descriptions is real but usually worth it — the model performs better when tool descriptions are precise, and the alternative (terse names + guess-what-they-do) fails more often.

## Interview defense

**Q: Why MCP and not direct tool definitions?**

Two reasons.

First, the tool set is provider-defined. Bloomreach's loomi connect server publishes its tools; I don't want to redefine them in my code and drift from the server's actual contract. MCP means the server IS the contract — every tool description, schema, and behavior comes from the source.

Second, swappability. `lib/mcp/config.ts` + `lib/mcp/auth-providers/` let a portfolio visitor point at their own MCP server via a settings modal — different URL, different auth type (OAuth Bloomreach, bearer, anonymous). Direct tool definitions would bind the agent to one provider; MCP makes the provider a runtime dependency.

*Anchor visual:* the swappable AuthProvider diagram above.

**Q: What's MCP's token overhead cost you?**

For 12 tools, ~2-3KB of tool descriptions in every listTools payload. At $3/million input tokens for Sonnet, that's roughly $0.01 per turn for tool descriptions alone. Real but small.

Escalation if the tool count grew (say to 50+): a pre-router narrows the tool set before each turn, using heuristics or embedding similarity. That would cut description tokens by ~80% and improve tool-selection accuracy simultaneously. Not needed yet at 12 tools.

**Q: What breaks in the swappable-MCP story?**

The one non-obvious constraint is that agents ASSUME certain tool categories exist. The MonitoringAgent expects `execute_analytics_eql`-shaped tools; if you point at an MCP server that only has file-system tools, the agent will fail. That's why `lib/agents/tool-coverage.ts` computes a coverage report — schema-driven check that tells the UI "this workspace doesn't support diagnostics because it lacks event streams." The swappability is at the AuthProvider layer; the tool-category assumption is a higher-level product coupling.

## See also

- **`02-agentic-retrieval/03-retrieval-routing.md`** — MCP tools as the source registry.
- **`03-multi-agent-orchestration/08-shared-state-and-message-passing.md`** — the DataSource is one of the scoped-blackboard resources.
- **`05-production-serving/03-per-tool-circuit-breaking.md`** — per-tool guards that live at the DataSource layer.
- **`.aipe/study-ai-engineering/04-agents-and-tool-use/02-tool-calling.md`** — mechanics of the tool call.

# Tool calling and MCP

*Industry name: tool calling / function calling / MCP (Model Context Protocol) — Industry standard.*

The connective tissue under every pattern in this guide. **This repo uses MCP directly** — `@modelcontextprotocol/sdk` over the Bloomreach loomi connect server, with per-agent tool policies enforced by AptKit. Tool calling is the substrate ReAct, agentic retrieval, and every multi-agent topology run on.

## Zoom out — where this concept lives

Tool calling is the bridge between the agent layer and the data layer. In this repo it goes through three abstractions: AptKit's `ToolRegistry`, Blooming's `BloomingToolRegistryAdapter`, and the `DataSource` seam (Bloomreach or Synthetic).

```
  Where tool calling lives in blooming insights

  ┌─ Agent layer ─────────────────────────────────────────────┐
  │  model emits tool_use block (intent) ─────────┐           │
  └────────────────────────────────────────────────┼──────────┘
                                                   ▼
  ┌─ AptKit layer ─ ToolRegistry interface ────────────────────┐
  │  filterToolsForPolicy(allTools, agent's toolPolicy)        │ ← we are here
  │  registry.callTool(name, args, {signal})                   │
  └────────────────────────────┬───────────────────────────────┘
                               ▼
  ┌─ Blooming adapter ─ BloomingToolRegistryAdapter ───────────┐
  │  delegates listTools + callTool to DataSource              │
  └────────────────────────────┬───────────────────────────────┘
                               ▼
  ┌─ DataSource layer ─ BloomreachDataSource | SyntheticDataSource ┐
  │  HTTPS over MCP transport (Bloomreach)                          │
  │  in-process synthetic ecommerce store (Synthetic)               │
  └─────────────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **who decides what tools the model can see vs use?**

```
  Layer                    Decision                                    Where
  ─────                    ────────                                    ─────
  MCP server (Bloomreach)  emits the FULL tool catalog (~30 tools)     external
  Route handler            listTools() to populate allTools[]          /api/agent
  AptKit per-agent policy  filterToolsForPolicy narrows to allowed     @aptkit/tools
  Model                    picks one tool from the allowed list         inside loop
  AptKit harness           validates name+args, runs via DataSource     runAgentLoop
  DataSource               actually executes (HTTPS or in-process)      lib/data-source/
```

Three filters between the MCP catalog and the model's choice: tool policy (least privilege), the model's pick (per turn), the harness's validation (catches a hallucinated tool name).

## How it works

### Move 1 — the mental model

You know REST APIs — endpoints exposed, the client picks which one to call. Tool calling is the same shape, except the "client" is the model and the model gets a description of each endpoint to decide from. MCP is the *protocol* that standardizes how those endpoint descriptions and calls travel between any model and any tool server — so a tool defined once is usable across agents without per-agent integration.

```
  Tool calling — the path of one call, one turn

  ┌─ Model ─────────────────────────────────────────────────┐
  │  reads tool catalog (filtered to its policy)             │
  │  emits: { type: 'tool_use', name: 'execute_analytics_eql',│
  │           input: { project_id, eql: '...' } }            │
  └────────────────────────────┬─────────────────────────────┘
                               ▼
  ┌─ Harness (AptKit runAgentLoop) ─────────────────────────┐
  │  catches the tool_use block                              │
  │  delegates: tools.callTool(name, input, {signal})        │
  └────────────────────────────┬─────────────────────────────┘
                               ▼
  ┌─ ToolRegistry adapter ──────────────────────────────────┐
  │  calls underlying DataSource                             │
  │  DataSource handles rate-limit + cache + retry           │
  └────────────────────────────┬─────────────────────────────┘
                               ▼
  ┌─ MCP transport (Bloomreach mode) ───────────────────────┐
  │  HTTPS POST with OAuth bearer token                      │
  │  unwrap: prefer structuredContent over content[0].text   │
  └────────────────────────────┬─────────────────────────────┘
                               ▼
  ┌─ Provider (Bloomreach loomi connect server) ────────────┐
  │  runs the EQL query, returns the result envelope         │
  └────────────────────────────┬─────────────────────────────┘
                               ▼
  ┌─ Back to the agent ─────────────────────────────────────┐
  │  result becomes a tool_result block in the next user msg │
  └──────────────────────────────────────────────────────────┘
```

### Move 2 — walk this repo's tool layer

**Step 1: the MCP server exposes a tool catalog.**

The Bloomreach loomi connect MCP server at `https://loomi-mcp-alpha.bloomreach.com/mcp` exposes ~30 tools — `execute_analytics_eql`, `get_metric_timeseries`, `list_scenarios`, `list_segmentations`, etc. The route handler fetches the full catalog:

```typescript
// app/api/briefing/route.ts:250-253
const raw = await dataSource.listTools({ signal: req.signal });
const allTools: McpToolDef[] = Array.isArray((raw as { tools?: unknown })?.tools)
  ? (raw as { tools: McpToolDef[] }).tools
  : [];
```

**Step 2: AptKit filters the catalog by the agent's policy.**

Each AptKit agent has a `toolPolicy` listing which tools it should see. Before the agent runs, AptKit calls `filterToolsForPolicy(allTools, policy)` to narrow the model's view:

- `anomalyMonitoringToolPolicy.allowedTools`: 4 tools (analytics + metric timeseries + segments + anomaly context)
- `diagnosticInvestigationToolPolicy.allowedTools`: 11 tools
- `recommendationToolPolicy.allowedTools`: 13 tools (different set — feature discovery)
- `queryToolPolicy.allowedTools`: 32 tools (the union)

The model only sees the filtered subset. Even if the MCP server adds a new tool, the agent won't use it until the policy is updated — that's the seam where capability changes get governed.

**Step 3: the agent's `BloomingToolRegistryAdapter` is the AptKit-side bridge.**

The adapter (`lib/agents/aptkit-adapters.ts:75-97`) is 23 lines:

```typescript
export class BloomingToolRegistryAdapter implements ToolRegistry {
  constructor(
    private readonly dataSource: McpCaller,
    private readonly allTools: McpToolDef[],
  ) {}

  listTools(): ToolDefinition[] {
    return this.allTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<{ result: unknown; durationMs: number }> {
    const { result, durationMs } = await this.dataSource.callTool(name, args, options);
    return { result, durationMs };
  }
}
```

What this is: the SEAM. AptKit talks to ToolRegistry; the adapter translates that into DataSource calls. Swap the DataSource (Bloomreach → Synthetic) and the adapter doesn't care.

**Step 4: the DataSource actually runs the tool.**

For `live-bloomreach`: `BloomreachDataSource` makes an HTTPS POST through the MCP transport, with the OAuth bearer token in the header. The transport handles rate-limit retry, cache lookup, and the unwrap of the response envelope (prefer `structuredContent`, else parse `content[0].text` as JSON).

For `live-synthetic`: `SyntheticDataSource` runs the tool in-process against Blooming-owned synthetic ecommerce data. Same DataSource interface, no network.

**Step 5: the result becomes a tool_result block on the next turn.**

The harness wraps the DataSource's result as a `tool_result` block and appends it to the next user message. The model sees the result on its next turn and decides what to do.

### Move 2.5 — why MCP and not just direct tool definitions?

This repo uses MCP as the protocol; the alternative would be defining tools inline in each agent class (the "direct tool definitions" approach LangChain and the OpenAI SDK have made common).

```
  Comparison — MCP vs direct tool definitions vs tool gateway

  Direct tool defs:                        MCP (this repo):
  ─────────────────                        ──────────────────
  tool schemas live in each agent's        tool schemas live on the MCP server
  code                                      and are fetched at runtime
                                            
  pro: full control over each tool's       pro: tool catalog is governed by the
       implementation                            server team; updates propagate
                                                automatically
  pro: zero protocol overhead               con: ~1 listTools call per request
                                                (mitigated by the 60s cache)
  con: each agent has to re-implement       pro: a tool defined once is usable
       integration with each backend             across any MCP-aware client
       (Bloomreach SDK, Salesforce SDK,         (Claude Desktop, Cursor, etc.)
       …)
  con: schema drift between agent and       pro: schema is the contract; drift is
       backend                                   caught at the transport layer

  Tool gateway:
  ─────────────
  one process that aggregates many tool sources
  pro: single integration point
  con: another moving piece, plus the gateway's own auth/rate-limit
```

The decision rationale for this repo: Bloomreach already runs the MCP server; consuming it via the protocol is cheaper than building a custom SDK. The 60s cache absorbs the cost of repeated `listTools` calls. The seam at `BloomingToolRegistryAdapter` means the agents don't even know they're talking to MCP — same code would work for direct tool definitions if MCP went away.

### Move 3 — the principle

Tool calling is the substrate every pattern in this guide runs on. The model never executes a tool itself — it emits intent (a `tool_use` block) and the harness validates and runs it. That boundary IS the safety story: the model can hallucinate a tool call to `delete_everything`, but if the tool isn't in the policy, the harness rejects it. **Tool policies are the most underappreciated security primitive in agent systems**; they're the agent-architecture version of "principle of least privilege."

MCP is THE protocol for standardizing this across vendors. It's worth knowing because the trend is clearly toward "your model can use any MCP server's tools" — Claude Desktop, Cursor, and many AI products are converging on MCP as the integration point. A skill in MCP transfers more broadly than a skill in LangChain's tool-definition API.

## In this codebase

**Yes — load-bearing.** Tool calling is the substrate every agent runs on; MCP is the protocol; per-agent tool policies are the access control. The relevant files:

- `lib/agents/aptkit-adapters.ts` — `BloomingToolRegistryAdapter` bridges AptKit ↔ DataSource
- `lib/agents/tool-schemas.ts` — `filterToolSchemas(all, allowed)` is the per-agent filter for the legacy path
- `lib/data-source/bloomreach-data-source.ts` — the MCP-over-HTTPS adapter with rate-limit + cache
- `lib/data-source/synthetic-data-source.ts` — the in-process alternative
- `lib/mcp/transport.ts` — the actual HTTPS transport
- `lib/mcp/auth.ts` + `lib/mcp/connect.ts` — OAuth/PKCE/DCR handshake

The MCP server it talks to: `https://loomi-mcp-alpha.bloomreach.com/mcp` (Bloomreach loomi connect, alpha).

## Primary diagram

The full tool-call path, every layer:

```
  Tool calling in blooming insights — one call, end to end

  ┌─ Agent layer ────────────────────────────────────────────┐
  │  model emits:                                             │
  │   { type: 'tool_use', name: 'execute_analytics_eql',      │
  │     input: { project_id: 'wobbly-ukulele',                │
  │              eql: 'select count event purchase ...' } }   │
  └────────────────────────────┬─────────────────────────────┘
                               ▼
  ┌─ AptKit runAgentLoop ────────────────────────────────────┐
  │  for each tool_use: tools.callTool(name, input, {signal}) │
  └────────────────────────────┬─────────────────────────────┘
                               ▼
  ┌─ BloomingToolRegistryAdapter ────────────────────────────┐
  │  this.dataSource.callTool(name, args, options)            │
  └────────────────────────────┬─────────────────────────────┘
                               ▼ (Bloomreach mode)
  ┌─ BloomreachDataSource ───────────────────────────────────┐
  │  - cache lookup (60s, per name+args)                      │
  │  - proactive ~1 req/s spacing                             │
  │  - rate-limit retry ladder                                │
  │  - MCP transport via @modelcontextprotocol/sdk            │
  └────────────────────────────┬─────────────────────────────┘
                               ▼
  ┌─ MCP transport (SdkTransport) ───────────────────────────┐
  │  HTTPS POST to https://loomi-mcp-alpha.bloomreach.com/mcp │
  │  with OAuth Bearer token (PKCE + DCR)                     │
  └────────────────────────────┬─────────────────────────────┘
                               ▼
  ┌─ Bloomreach loomi connect server ────────────────────────┐
  │  runs the EQL query, returns                              │
  │  { result: {...}, structuredContent: {...} | content[]: } │
  └────────────────────────────┬─────────────────────────────┘
                               ▲ (response unwrapping)
  ┌─ unwrap (lib/mcp/schema.ts) ─────────────────────────────┐
  │  prefer structuredContent if non-null                     │
  │  else JSON.parse(content[0].text)                         │
  └────────────────────────────┬─────────────────────────────┘
                               ▼
  ┌─ back into the loop's message array ─────────────────────┐
  │  { type: 'tool_result', tool_use_id, content: <JSON> }    │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

MCP (Model Context Protocol) was announced by Anthropic in late 2024 as an open standard for connecting models to tools and data. The motivation: every AI product was building its own version of "function calling against my tools," and the protocols were drifting (OpenAI function calling, Anthropic tool_use, LangChain tools, ...). MCP fills that gap with a standard wire format and a standard client/server SDK.

The production wisdom on MCP: the win is when you have many tools and many clients (Claude Desktop + Cursor + your custom app all using the same tool set) — defining the tool once on the server side saves N integrations. The cost is the protocol overhead: each request includes a `listTools` round-trip unless cached, and the response envelope (`content[]` + optional `structuredContent`) requires an unwrap helper.

For this repo, the win was that Bloomreach already ran the MCP server. Building a custom Bloomreach SDK would have been weeks of work; consuming the existing MCP server was hours. The seam at `BloomingToolRegistryAdapter` means we're not locked in — if MCP went away, the DataSource interface stays and the adapter swaps.

The pattern that pairs naturally with MCP: *capability gating* (`lib/agents/categories.ts`). Each tool policy is a capability declaration; each schema-capability check is a runtime guard that the model won't ask for a tool it can't actually use. Tools + policies + capabilities together form the agent's "least privilege" surface.

## Interview defense

**Q: "How does your agent call tools?"**

A: Through MCP — `@modelcontextprotocol/sdk` over the Bloomreach loomi connect server at `https://loomi-mcp-alpha.bloomreach.com/mcp`. The path is: model emits a `tool_use` block (intent only — never runs the tool itself) → AptKit's runAgentLoop catches it → BloomingToolRegistryAdapter delegates to the DataSource → BloomreachDataSource handles cache + ~1 req/s spacing + rate-limit retry → HTTPS POST with OAuth bearer to the MCP server → response unwrapped (prefer `structuredContent`, else parse `content[0].text`) → result becomes a `tool_result` block on the next turn. Per-agent tool policies (`anomalyMonitoringToolPolicy.allowedTools`, etc.) filter the catalog before the model sees it — least privilege at the tool layer. The seam at `BloomingToolRegistryAdapter` (`lib/agents/aptkit-adapters.ts:75`) means the agents don't know they're talking to MCP — if MCP went away, the same code works against direct tool definitions.

Diagram I'd sketch:

```
  model emits tool_use ─► AptKit catches ─► BloomingToolRegistryAdapter
                                                       │
                                                       ▼
                                           BloomreachDataSource (cache + retry)
                                                       │
                                                       ▼
                                           MCP transport (HTTPS + OAuth)
                                                       │
                                                       ▼
                                           Bloomreach loomi connect server
```

Anchor: "the boundary is `tool_use` from the model vs `callTool` in the harness. The model never touches the network; the harness does. That's the safety story — a hallucinated tool name fails at the policy filter, not at the network."

**Q: "Why MCP and not a custom SDK?"**

A: Two reasons. First, Bloomreach already ran the MCP server — building a custom Bloomreach SDK would have been weeks; consuming MCP was hours. Second, MCP is the trend — Claude Desktop, Cursor, and many AI products are converging on MCP as the integration point. A skill in MCP transfers more broadly than a skill in any vendor's tool-definition API. The cost is the protocol overhead (a `listTools` per request, the response-envelope unwrap), but the 60s cache absorbs most of it. The seam at `BloomingToolRegistryAdapter` keeps us un-locked-in: if we ever wanted direct tool definitions, the DataSource interface stays, the adapter swaps.

## See also

- [`01-context-engineering.md`](./01-context-engineering.md) — tool grants are context engineering at the tool layer
- [`05-guardrails-and-control.md`](./05-guardrails-and-control.md) — tool policies are part of the control envelope
- [`../03-multi-agent-orchestration/02-supervisor-worker.md`](../03-multi-agent-orchestration/02-supervisor-worker.md) — tool calling is what the workers do
- ai-engineering's `tool-calling` file (cross-ref) — the mechanics, if generated

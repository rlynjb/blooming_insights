# Tool calling and MCP

_Industry standard._

## Zoom out, then zoom in

The connective tissue under every pattern. In this repo the substrate is threefold: (a) Anthropic's tool-calling protocol at the wire, (b) MCP (Model Context Protocol) at the tool-server layer via `@modelcontextprotocol/sdk`, and (c) AptKit's provider-neutral `ToolRegistry` primitive bridged by `BloomingToolRegistryAdapter`. That last one is the load-bearing seam — it lets the same tools serve every agent without per-agent integration.

```
  Zoom out — the three layers of tool calling

  ┌─ Model surface (Anthropic tool_use / tool_result) ──────────┐
  │  Sonnet 4.6 emits tool_use blocks; runtime feeds results     │
  └───────────────────────────┬─────────────────────────────────┘
                              │ AptKit converts to ModelTool
  ┌─ AptKit runtime (ToolRegistry primitive) ───────────────────┐
  │  listTools() + callTool(name, args) — provider-neutral       │
  └───────────────────────────┬─────────────────────────────────┘
                              │ BloomingToolRegistryAdapter
  ┌─ Tool source (MCP over OAuth+PKCE to Bloomreach) ───────────┐
  │  BloomreachDataSource / SyntheticDataSource                  │
  │  ~30 tools including execute_analytics_eql, list_scenarios,  │
  │  list_events, list_customer_properties                       │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the `BloomingToolRegistryAdapter` is where a tool defined once at the MCP layer becomes usable by every AptKit agent (Monitoring, Diagnostic, Recommendation, Query). Adding a new tool to Bloomreach's MCP surface makes it available to all agents *without* per-agent integration code.

## Structure pass

**Layers:** model (tool_use blocks) · runtime (ToolRegistry) · adapter (BloomingToolRegistryAdapter) · MCP transport · Bloomreach.
**Axis:** *at which layer does swapping the tool source require code changes?*
**Seam:** the `DataSource` interface (the port). Swap the adapter, everything above stays the same. This seam has already survived two adapter swaps (Olist added, Olist removed, Synthetic added, FaultInjecting decorator added) with zero caller-surface changes.

```
  The DataSource port — one interface, many adapters

  ┌─ AptKit agents (unaware of source) ─────────────────────────┐
  │  DiagnosticAgent, RecommendationAgent, MonitoringAgent, ... │
  └───────────────────────────┬─────────────────────────────────┘
                              │ BloomingToolRegistryAdapter(dataSource, tools)
                              ▼
  ┌─ DataSource interface (the port) ───────────────────────────┐
  │  callTool(name, args, opts) → { result, durationMs }         │
  │  listTools() → ToolDef[]                                     │
  └───┬──────────────┬─────────────────────┬────────────────────┘
      │              │                     │
      ▼              ▼                     ▼
  ┌────────┐   ┌──────────┐         ┌──────────────┐
  │Bloom.  │   │Synthetic │         │FaultInjecting│  ← decorator
  │Data-   │   │DataSource│         │  wraps any   │
  │Source  │   │          │         │  of the above│
  └────────┘   └──────────┘         └──────────────┘
```

## How it works

### Move 1 — the mental model

You've used dependency injection before — pass an interface, not a concrete class, so the collaborator can be swapped. That's this codebase's tool-calling story exactly. Every agent takes a `DataSource` (the port) at construction; the concrete adapter (Bloomreach, Synthetic, FaultInjecting) is picked outside. The agent code doesn't know or care where the tool result came from.

```
  Pattern: dependency injection at the tool boundary

  agent = new DiagnosticAgent(anthropic, dataSource, schema, tools, sid);
                                           │
                                           ▼
                                    Interface, not concrete class
                                    Anything with callTool() works
```

### Move 2 — the walkthrough

**The port — `lib/data-source/types.ts`.** The DataSource interface defines what every source promises:

```ts
// lib/data-source/types.ts (shape)
export interface DataSource {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: DataSourceCallOptions,
  ): Promise<DataSourceCallResult>;

  listTools(opts?: DataSourceListOptions): Promise<unknown>;
}
```

Line-by-line: two methods. `callTool` runs a tool. `listTools` returns the tool catalog. That's the whole surface. Every downstream concern (rate limits, retries, caching, fault injection) lives *behind* this interface, not on it.

**The adapter — `lib/agents/aptkit-adapters.ts:124-146`.** `BloomingToolRegistryAdapter` bridges the DataSource port to AptKit's `ToolRegistry` primitive:

```ts
// aptkit-adapters.ts:124-146 — the bridge
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

Line-by-line:

- **`implements ToolRegistry`** — the aptkit-side type contract. AptKit calls `.listTools()` at bootstrap and `.callTool()` on every model tool_use block.
- **`listTools()` transforms shape** — the internal `McpToolDef` (Blooming's tool definition shape) maps to AptKit's `ToolDefinition`. Only three fields: name, description, inputSchema. The MCP-specific fields (`project_id` requirement, `structuredContent` envelope) don't leak into AptKit.
- **`callTool()` delegates directly.** The adapter is thin — no logic here. All the retry/cache/rate-limit lives in `BloomreachDataSource`.

**The MCP layer — `lib/mcp/client.ts` (invoked via `BloomreachDataSource`).** MCP is the protocol that makes tools portable across agents. Bloomreach exposes ~30 tools via `StreamableHTTPClientTransport` on `https://loomi-mcp-alpha.bloomreach.com/mcp`. The client handles the wire protocol (JSON-RPC), auth (OAuth+PKCE with Dynamic Client Registration), and the response envelope (prefer `structuredContent`, fall back to `content[0].text`).

Every MCP tool call carries `project_id` (bootstrap chain: `list_cloud_organizations` → `list_projects` → cache the id). Rate limit is ~1 req/s, enforced by `minIntervalMs=1100` in the data source. See `05-production-serving/01-rate-limit-compliance.md` for the retry ladder.

**Why MCP as the substrate.** Blooming's alternative would be per-agent tool implementations — the DiagnosticAgent has its own EQL client, the RecommendationAgent has its own scenario-list client, etc. That would mean N implementations of the same 30 tools, N copies of the OAuth token refresh, N places to update when Bloomreach changes an API. MCP collapses these to one: define the tool once at the MCP server, every agent that reaches through the DataSource sees it.

The transferable point: MCP standardizes *how* agents connect to tools. Anthropic's tool_use protocol standardizes *how* the model requests them. AptKit's ToolRegistry standardizes *how* the runtime dispatches them. Blooming's DataSource port standardizes *how* the app swaps between sources. Four levels of standardization, each one collapsing a class of duplication.

```
  Layers-and-hops — one tool call, all layers

  ┌─ DiagnosticAgent (via AptKit runAgentLoop) ─────────────────┐
  │  model emits: tool_use { name: "execute_analytics_eql",     │
  │                           input: { eql: "..." } }           │
  └───────────────────────────┬─────────────────────────────────┘
                              │ AptKit calls registry.callTool(name, args)
                              ▼
  ┌─ BloomingToolRegistryAdapter ───────────────────────────────┐
  │  delegates to dataSource.callTool(name, args, opts)          │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
  ┌─ BloomreachDataSource ──────────────────────────────────────┐
  │  cache lookup → rate-limit gate → MCP call → retry ladder    │
  └───────────────────────────┬─────────────────────────────────┘
                              │ JSON-RPC over HTTPS
                              ▼
  ┌─ Bloomreach MCP server ─────────────────────────────────────┐
  │  runs the EQL against workspace                              │
  └───────────────────────────┬─────────────────────────────────┘
                              │ structuredContent envelope
                              ▼
  ┌─ Result flows back up (result + durationMs + fromCache) ────┐
  │  becomes tool_result block in next model turn                │
  └─────────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

Tool calling in production needs standardization at every layer: at the model protocol (Anthropic's tool_use), at the runtime (AptKit's ToolRegistry), at the app boundary (Blooming's DataSource port), at the tool server (MCP). Each layer's standardization eliminates a class of duplication. The load-bearing seam for the app is the DataSource port — swap adapters (Bloomreach ⇄ Synthetic ⇄ FaultInjecting) without touching agent code. This seam has survived three swaps already, which is the proof it's placed right. The interview-grade version: don't reinvent tool calling per agent; define the port, adapt each source, let the model talk to one runtime.

## Primary diagram

```
  Recap — the layered tool-calling stack

  ┌─ Anthropic Sonnet 4.6 ──────────────────────────────────────┐
  │  emits tool_use blocks; consumes tool_result blocks          │
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌─ AptKit runAgentLoop ─────▼─────────────────────────────────┐
  │  ToolRegistry primitive → registry.callTool(name, args)     │
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌─ BloomingToolRegistryAdapter ─────▼─────────────────────────┐
  │  bridges to DataSource port                                 │
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌─ DataSource (port) ────────▼────────────────────────────────┐
  │  Adapters: Bloomreach / Synthetic / FaultInjecting          │
  │  Concerns: cache + rate-limit + retry (Bloomreach only)     │
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌─ MCP protocol layer ───────▼────────────────────────────────┐
  │  JSON-RPC over StreamableHTTPClientTransport                │
  │  OAuth+PKCE + Dynamic Client Registration                   │
  │  ~30 tools; structuredContent envelope                      │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

MCP as a protocol was released by Anthropic in late 2024. Its pitch: standardize how LLM apps connect to tools and data, so an ecosystem of MCP servers can serve any MCP client. Bloomreach's alpha `loomi connect` server is one of those servers; blooming is one of those clients. The value proposition is real — the same tool catalog can serve every agent, every framework, every provider, once wrapped in MCP.

The tension inside blooming is between two "standardizations": MCP standardizes the *wire*, AptKit's ToolRegistry standardizes the *runtime*. Both are useful. The bridge (`BloomingToolRegistryAdapter`) is the compromise — MCP-shaped tools flow through AptKit-shaped registries via a thin translation layer. The alternative would be picking one and adapting the other's clients — either MCP-native everywhere (and forgo AptKit's agent primitives) or AptKit-native everywhere (and lose the MCP ecosystem). The adapter picks up both.

The overhead: every tool description flows through the model's prompt on every call, cached but still counted toward the input tokens on turn 1. The Anthropic ephemeral cache breakpoint on the system prompt covers tools transparently (`01-context-engineering.md`), so turns 2-N are cheap. Direct tool definitions (skip MCP) would save a modest amount of wire overhead but forfeit the swap-any-source property. Not worth it for blooming's scale.

## Interview defense

**Q: What's the substrate under every agent's tool calling in this codebase?**
A: Four layers of standardization. At the wire, Anthropic's tool_use protocol — the model emits tool_use blocks, the runtime feeds results as tool_result blocks. At the runtime, AptKit's ToolRegistry primitive — a provider-neutral surface with `listTools()` and `callTool()`. At the app boundary, blooming's `DataSource` port — same interface exposed by Bloomreach, Synthetic, and FaultInjecting adapters. At the tool server, MCP over OAuth+PKCE with a `structuredContent` envelope. The load-bearing seam is the DataSource port; it's already survived three adapter swaps (Olist added and removed, Synthetic added, FaultInjecting decorator added) with zero changes to agent code. That's the proof the seam is placed right.

Diagram: the four-layer stack with each standardization named.
Anchor: `lib/agents/aptkit-adapters.ts:124-146` (BloomingToolRegistryAdapter) + `lib/data-source/types.ts` (the port).

**Q: Why MCP as the substrate — why not per-agent tool implementations?**
A: N agents times M tools means N×M implementations, N copies of the OAuth flow, N places to update when Bloomreach changes an API. MCP collapses this: define the tool once at the server, expose it through one client, every agent reaches through the same DataSource port. The overhead is a modest amount of wire framing (JSON-RPC), which is negligible compared to model tokens. Where MCP's ecosystem value shows up: if Bloomreach adds a new tool tomorrow, every agent gains access without a code change — the tool appears in `listTools()` and the model can call it. That's the specific dividend the standardization pays.

Diagram: the N×M duplication picture beside the 1×M MCP picture.
Anchor: `lib/mcp/client.ts` (MCP client) + `lib/agents/aptkit-adapters.ts:124-146` (adapter).

## See also

- `03-multi-agent-orchestration/02-supervisor-worker.md` — the topology that reuses the same tool catalog.
- `05-production-serving/01-rate-limit-compliance.md` — the retry ladder BloomreachDataSource applies to every tool call.
- `05-production-serving/03-fault-injection-and-graceful-degradation.md` — the FaultInjecting decorator, another adapter on the same port.
- Cross-reference: `.aipe/study-ai-engineering/`'s tool-calling file for the model-side mechanics.

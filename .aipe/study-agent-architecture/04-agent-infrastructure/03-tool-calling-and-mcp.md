# Tool calling and MCP

**Industry standard.** The connective tissue under every pattern. **Deeply exercised** in this repo — every agent runs over MCP, one server, ~33 tools.

## Zoom out, then zoom in

Sits as the substrate every reasoning pattern, every retrieval, and every multi-agent topology runs on. The model emits typed `tool_use` blocks; the runtime dispatches them; results come back as `tool_result` blocks. MCP is the protocol that standardizes how the agent connects to tools — once a tool is defined on an MCP server, it's usable across any MCP-aware agent without per-agent integration.

```
  Zoom out — where this concept lives

  ┌─ Agent loop ─────────────────────────────────────┐
  │  emits tool_use, reads tool_result               │
  └───────────────────────┬──────────────────────────┘
                          │
  ┌─ Tool registry ──────▼──────────────────────────┐
  │  BloomingToolRegistryAdapter (the port)          │ ← we are here
  │   → DataSource.callTool                          │
  └───────────────────────┬──────────────────────────┘
                          │
  ┌─ Data source ────────▼──────────────────────────┐
  │  BloomreachDataSource (the adapter)              │
  │   → MCP transport → Bloomreach loomi connect     │
  └──────────────────────────────────────────────────┘
```

## Structure pass

Layers: tool schema (the model's contract — name, description, input_schema) → tool intent (the model's emitted `tool_use` block) → tool dispatch (the harness's `tools.callTool` call) → tool execution (the adapter's wire call) → tool result (the model's observed `tool_result` block).

**Axis traced — "where does the model's tool intent become a network call?":** the model emits intent into the conversation; the harness reads it from the response; the tool registry's `callTool` is the seam where intent becomes execution; the data-source adapter is where the actual wire call happens.

**Seam:** the `ToolRegistry` port (`@aptkit/tools`'s `ToolRegistry` type). On one side: the agent loop that knows nothing about MCP. On the other: the adapter that knows everything about MCP. Swap the adapter, swap the substrate.

## How it works

### Move 1 — the mental model

You know the dependency injection pattern — your code calls an interface, the framework injects a concrete implementation. Tool calling is the same: the model "calls" tools by emitting typed intents; the runtime injects the actual implementation via the registry. MCP is the wire protocol that lets the injection cross process boundaries — the registry on this side talks to an MCP server on the other side, which exposes a set of tools the client can list and call.

```
  Tool calling — the typed intent dispatched through a port

  agent loop
       │  emits: tool_use { name, input }
       ▼
  ┌─ ToolRegistry port (interface) ──────────────────┐
  │   listTools(): ToolDefinition[]                  │
  │   callTool(name, args, options) → { result, ms } │
  └─────────────────┬────────────────────────────────┘
                    │  any conforming adapter
       ┌────────────┼────────────┐
       ▼            ▼            ▼
  in-memory     Bloomreach    synthetic
  (tests)       (production)  (fallback)
       │            │             │
       │            ▼             │
       │      MCP transport       │
       │      (HTTP + OAuth)      │
       │            │             │
       │            ▼             │
       │      Bloomreach          │
       │      loomi connect       │
       │      server               │
       │      (~33 tools)         │
       │                          │
   no wire call;             no wire call;
   handlers run               in-process
   inline                     synthetic data
```

The agent loop only knows the `ToolRegistry` interface. Three adapters conform: the in-memory `InMemoryToolRegistry` (from `@aptkit/tools`) for tests, the Blooming `BloomingToolRegistryAdapter` over `BloomreachDataSource` for production, and the same adapter over `SyntheticDataSource` for the `live-synthetic` mode.

### Move 2 — step by step

#### The tool schema — what the model sees

Open `lib/agents/tool-schemas.ts:3-7`:

```ts
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: object;
}
```

Three fields. The model sees these in its system prompt's tool list:

- `name` — the tool's callable identifier (`execute_analytics_eql`, `get_segments`, etc.).
- `description` — natural-language description of when to use it; the model relies on this to pick between tools.
- `inputSchema` — JSON Schema describing the tool's input. Anthropic's API uses this to constrain the model's `tool_use.input` to a valid shape.

Bloomreach's MCP server exposes ~33 of these. `dataSource.listTools()` (in `app/api/agent/route.ts:239-243`) lists them all; `filterToolsForPolicy` narrows the list to each agent's allowlist before passing to `runAgentLoop`.

#### The tool intent — what the model emits

The model's response content includes one or more `tool_use` blocks per turn:

```ts
// Anthropic's content block type (paraphrased)
type ToolUseBlock = {
  type: 'tool_use';
  id: string;                    // for matching with the tool_result
  name: string;                  // tool name from the allowlist
  input: Record<string, unknown>; // matches the inputSchema
};
```

The harness reads these from `response.content` (`run-agent-loop.js:53-57`):

```js
const toolUses = toolUsesFromContent(response.content);
if (toolUses.length === 0) {
  finalText = text;
  break;
}
```

If there are no `tool_use` blocks, the loop terminates (success exit). If there are, the harness dispatches each via the tool registry.

#### The tool dispatch — the typed seam

The dispatch is two layers. First, AptKit's runtime calls the registry (`run-agent-loop.js:76`):

```js
const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
```

Second, the Blooming registry adapter delegates to the data source (`lib/agents/aptkit-adapters.ts:89-96`):

```ts
async callTool(name, args, options?) {
  const { result, durationMs } = await this.dataSource.callTool(name, args, options);
  return { result, durationMs };
}
```

The adapter strips the `fromCache` field from the data source's three-field envelope (`{result, durationMs, fromCache}`) — AptKit's `ToolRegistry` interface only wants two fields. The `fromCache` is still observable in the route handler's trace events (it gets passed through to the UI's "how this was gathered" panel separately).

The seam is doing real work: the agent loop knows nothing about MCP, OAuth, rate-limiting, or caching. Everything below the registry call is data-source concern. This is the dependency-inversion pattern made concrete.

#### The MCP transport — what's under the data source

Open `lib/data-source/bloomreach-data-source.ts:190-205`:

```ts
private async liveCall(name, args, signal?): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {       // ~1 req/s proactive spacing
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  try {
    const result = await this.transport.callTool(name, args, { signal });
    this.lastCallAt = Date.now();
    return result;
  } catch (err) {
    this.lastCallAt = Date.now();
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}
```

The `transport.callTool` is the actual MCP SDK call — `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk` wrapped with an OAuth client provider (`lib/mcp/auth.ts`) and the rate-limit retry ladder (lines 163-174 of `bloomreach-data-source.ts`).

The MCP wire is HTTP — request goes to `https://loomi-mcp-alpha.bloomreach.com/mcp` carrying the OAuth bearer token + the tool call payload (JSON-RPC over HTTP); response comes back as a JSON-RPC envelope containing the tool result. The response envelope can be `{ structuredContent: {...} }` (the preferred shape) or `{ content: [{ type: 'text', text: '...' }] }` (the fallback shape); `lib/mcp/schema.ts:unwrap` handles both.

#### Why MCP matters here — the standardization win

MCP's value is that the same tool registry pattern works across MCP servers. If Bloomreach ever stood up a second MCP server (say, a campaigns-specific server), this repo would add a second `BloomreachDataSource` instance and a composite registry — the agent loop would not change. If the team wanted to add a non-Bloomreach MCP server (e.g. an internal docs server), same pattern.

Without MCP, the alternative would be per-tool Anthropic adapters — one TypeScript function per Bloomreach API endpoint, each with a hand-written schema, each wired into the registry by name. MCP collapses 33 such adapters into one transport call.

The token overhead trade-off MCP introduces: each tool definition takes ~200 tokens in the system prompt (the model sees all allowed tools' schemas). For 33 tools, that's ~6,600 tokens of overhead per turn for the query agent. The per-agent allowlist narrowing (`02-agentic-retrieval/03-retrieval-routing.md`) is the mitigation.

#### MCP vs direct tool definitions vs a tool gateway — the decision

Three deployment shapes, decision per shape:

- **Direct tool definitions** (hand-coded TypeScript functions registered with the agent): cheapest if you have 5-10 tools and they're all in-process. No protocol overhead, no transport, no OAuth.
- **MCP** (this repo): right when the tools live behind a service boundary, when the same tools need to be usable across agents/products, or when third-party providers expose MCP. Protocol overhead is real but the standardization win pays for it.
- **Tool gateway** (a single in-process registry that dispatches to multiple MCP servers + direct tools): the production answer when you have multiple substrates. Composes MCP and direct tools behind one registry the agent sees.

This repo lands on MCP because (a) Bloomreach exposes its analytics via MCP and (b) the team didn't want to maintain 33 hand-coded adapter functions for a third-party API surface that changes with the alpha. The trade-off was the right call.

### Move 3 — the principle

**Tool calling is the substrate, MCP is the protocol that makes the substrate composable.** The two are inseparable in practice — the model needs to emit typed intents (tool calling), the runtime needs to dispatch them somewhere (MCP gives that somewhere a standard interface). The decision to make MCP-aware is one of those small architectural calls that pays off later: any future agent in this repo gets the same tool surface for free, any future MCP server slots in via a new `DataSource` adapter without touching the agents.

## Primary diagram

```
  Full tool-call path — model intent to MCP wire and back

  ┌─ agent loop turn N (assistant response) ──────────────────────┐
  │   content: [                                                    │
  │     { type: 'text', text: 'Thought: ...' },                    │
  │     { type: 'tool_use', id: 'toolu_abc', name:                 │
  │       'execute_analytics_eql', input: { project_id: '...',     │
  │       eql: '...' } }                                            │
  │   ]                                                              │
  └────────────────────────────────────┬───────────────────────────┘
                                       │
                                       ▼
  ┌─ run-agent-loop.js:53-76 ──────────────────────────────────────┐
  │   const toolUses = toolUsesFromContent(response.content);       │
  │   for (const toolUse of toolUses):                              │
  │     const { result, durationMs } = await tools.callTool(        │
  │       toolUse.name, toolUse.input, { signal }                   │
  │     );                                                           │
  └────────────────────────────────────┬───────────────────────────┘
                                       │ ToolRegistry port
                                       ▼
  ┌─ lib/agents/aptkit-adapters.ts:75-97 ──────────────────────────┐
  │   BloomingToolRegistryAdapter.callTool(name, args, opts):       │
  │     return this.dataSource.callTool(name, args, opts);          │
  └────────────────────────────────────┬───────────────────────────┘
                                       │ DataSource port
                                       ▼
  ┌─ lib/data-source/bloomreach-data-source.ts:139-188 ────────────┐
  │   BloomreachDataSource.callTool:                                │
  │     1. cache key = name:JSON.stringify(args)                    │
  │     2. cache hit (60s TTL)? return                              │
  │     3. liveCall: 200ms spacing → transport.callTool             │
  │     4. is rate-limited? sleep + retry (up to 3x, parsed retry- │
  │        after window honored)                                    │
  │     5. cache result if not error                                │
  │     6. return { result, durationMs, fromCache: false }          │
  └────────────────────────────────────┬───────────────────────────┘
                                       │ MCP transport
                                       ▼
  ┌─ lib/mcp/transport.ts → @modelcontextprotocol/sdk ─────────────┐
  │   StreamableHTTPClientTransport (HTTP + OAuth bearer)           │
  │   POST https://loomi-mcp-alpha.bloomreach.com/mcp               │
  │   Body: JSON-RPC { method: 'tools/call', params: {...} }        │
  │   Response: JSON-RPC envelope                                   │
  │     { structuredContent: {...} } OR                              │
  │     { content: [{ type: 'text', text: '...' }] }                │
  └────────────────────────────────────┬───────────────────────────┘
                                       │ result
                                       ▼
  ┌─ back up the stack ────────────────────────────────────────────┐
  │   run-agent-loop.js:97-104:                                     │
  │     toolResults.push({ type: 'tool_result', toolUseId: id,     │
  │                        content: truncate(JSON.stringify(result))│
  │                      });                                         │
  │     messages.push({ role: 'user', content: toolResults });      │
  │   loop back to turn N+1                                         │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The Model Context Protocol (MCP) was introduced by Anthropic in November 2024 to standardize the interface between LLM agents and external tools/data sources. Before MCP, every team built per-tool adapters in their agent framework of choice; MCP makes the adapter the protocol's job, not the agent framework's job. The win shows up in cross-product reuse: Anthropic Desktop, Cursor, Cline, this repo — all consume MCP servers using compatible clients.

The Bloomreach team's choice to expose loomi connect over MCP (rather than a REST API the Blooming team would have to hand-wrap) is exactly the standardization win — by speaking MCP they make their analytics surface usable in any MCP-aware agent system. This repo benefits directly: zero hand-written adapter code for the 33 tools.

The token overhead of carrying tool definitions in the system prompt is the cost everyone pays for tool calling, MCP or not. The mitigation strategies are: narrow allowlists per agent (this repo's choice), tool-gateway summarization (a wrapper that compresses tool descriptions), or per-turn dynamic tool selection (the model first picks a tool *category*, then the harness exposes only that category's tools for the next turn). For 33 tools in this repo, narrow allowlists are the right answer; for 200+ tools, dynamic selection becomes the production pattern.

## Interview defense

> **Q: Walk through what happens when the diagnostic agent calls a tool.**
>
> Four layers. The model emits a `tool_use` content block in its response — `{ type: 'tool_use', name: 'execute_analytics_eql', input: { ... } }`. The harness in `runAgentLoop` reads it and calls `tools.callTool(name, input, options)` against the `ToolRegistry` port. The port is implemented by `BloomingToolRegistryAdapter` in `lib/agents/aptkit-adapters.ts:75-97`, which delegates to the `DataSource` port. The data source is `BloomreachDataSource` (`lib/data-source/bloomreach-data-source.ts`), which checks the 60s cache, enforces the 200ms minimum interval, runs the rate-limit retry ladder, and ultimately calls the MCP transport — `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk` — which POSTs JSON-RPC to `https://loomi-mcp-alpha.bloomreach.com/mcp` with an OAuth bearer token. The response comes back as a JSON-RPC envelope; the data source returns `{result, durationMs, fromCache}`; the adapter drops the `fromCache`; the harness packages the result as a `tool_result` content block for the next turn.

> **Q: Why MCP instead of hand-coding 33 TypeScript tool adapters?**
>
> Standardization and cross-product reuse. Bloomreach exposes their analytics surface via MCP (the loomi connect server), and any MCP-aware agent client can consume it without per-product integration work. If we hand-coded 33 adapters, every API change on Bloomreach's side would require a Blooming PR; with MCP, the server's tool schemas are the source of truth and the client picks them up on `listTools()` automatically. The cost is the protocol overhead (tool definitions live in the system prompt, ~200 tokens each; 33 tools × 200 = ~6.6K token overhead per turn for the query agent). The mitigation is per-agent allowlist narrowing — the monitoring agent only sees 4 of the 33 tools, saving ~5.8K tokens per turn.

> **Q: What's the trade-off between MCP, direct definitions, and a tool gateway?**
>
> Direct definitions (hand-coded TypeScript functions) are cheapest for small in-process tool sets — no protocol overhead, no transport. MCP is right when tools live behind a service boundary, when the same tools need to be usable across multiple agents, or when third-party providers expose MCP. A tool gateway is the production answer when you have multiple substrates — a single in-process registry that dispatches to direct tools, MCP servers A and B, etc., behind one interface the agent sees. This repo is MCP-only because (a) Bloomreach exposes one MCP server and (b) we didn't want to maintain 33 hand-coded adapters for a third-party API surface. If we added an internal docs MCP server later, we'd evolve into a tool-gateway shape — `CompositeDataSource` over multiple data sources.

## See also

- → `01-reasoning-patterns/02-agent-loop-skeleton.md` — the harness that dispatches the tool calls
- → `01-reasoning-patterns/03-react.md` — the prompting strategy that produces tool_use blocks
- → `02-agentic-retrieval/03-retrieval-routing.md` — the per-agent allowlist narrowing
- → `05-production-serving/03-per-tool-circuit-breaking.md` — the retry/cache behavior inside `BloomreachDataSource`
- → cross-reference (when generated): `study-system-design`'s provider-abstraction file — the same `DataSource` port from a system-design lens

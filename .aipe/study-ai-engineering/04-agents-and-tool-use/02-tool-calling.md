# Tool calling

## Subtitle

Function calling / structured tool invocation — Industry standard.

## Zoom out, then zoom in

Every meaningful thing the agents do — running EQL queries, listing catalogs, checking segment sizes — happens through tool calls. The model doesn't run tools; it emits `tool_use` blocks whose input matches a schema. Your code (in blooming, the `BloomingToolRegistryAdapter`) runs the tool and hands the result back to the model as a `tool_result` block. That's the whole loop.

```
  Zoom out — where tools sit

  ┌─ Agent (aptkit loop) ──────────────────────────────┐
  │  model emits tool_use                                │
  └───────────────────────┬──────────────────────────────┘
                          │  tool_use.name + tool_use.input
                          ▼
  ┌─ BloomingToolRegistryAdapter ★ ────────────────────┐ ← we are here
  │  lib/agents/aptkit-adapters.ts                      │
  │  · looks up tool by name                            │
  │  · executes via DataSource.callTool                 │
  │  · wraps result as tool_result block                │
  └───────────────────────┬──────────────────────────────┘
                          │  ToolResult
                          ▼
  ┌─ DataSource (McpDataSource / Synthetic / etc) ─────┐
  │  actually calls the MCP tool over the transport     │
  └──────────────────────────────────────────────────────┘
```

Zoom in: tool calling is the way an LLM affects the world without being able to. Model has the brain; adapter has the hands.

## Structure pass

- **Layers:** LLM → tool_use → registry → DataSource → transport → server. Six bands.
- **Axis: who does what?** LLM decides *what* to call. Registry decides *how* to invoke. DataSource decides *where* to call. All three are separate, all three are swappable.
- **Seam:** the `ToolRegistry` port from aptkit. The port names the shape; the adapter maps it to blooming's world.

## How it works

### Move 1 — the mental model

You know how a `fetch()` on the client sends a request the server executes? Tool calling is the model's `fetch()`. It emits a request (`tool_use { name, input }`), your code executes it, you hand back the response (`tool_result { content }`), the model continues.

```
  Tool call — the shape

  model emits:
    { type: "tool_use",
      name: "execute_analytics_eql",
      input: { project_id: "...", eql: "..." } }
              │
              ▼  your code (BloomingToolRegistryAdapter.execute)
              │
    dataSource.callTool("execute_analytics_eql", input)
              │
              ▼  MCP transport
              │
    result comes back
              │
              ▼  your code wraps as
              │
    { type: "tool_result",
      tool_use_id: "...",
      content: [{ type: "text", text: JSON.stringify(result) }],
      is_error: false }
              │
              ▼  next model turn sees it
```

### Move 2 — the step-by-step walkthrough

**The tool schema is where the contract lives.** `lib/agents/tool-schemas.ts:9` — `filterToolSchemas(all, allowed)` filters the full MCP tool list down to a specific agent's allowed subset. The MCP server ships each tool with an `inputSchema` (JSON schema); blooming relays it directly to Anthropic. Model reads the schema; model constrains its output to match; model emits schema-valid `tool_use.input`.

**The registry adapter is where the dispatch lives.** `BloomingToolRegistryAdapter` in `lib/agents/aptkit-adapters.ts`:

```ts
// simplified — the real class implements aptkit's ToolRegistry port
class BloomingToolRegistryAdapter implements ToolRegistry {
  constructor(
    private dataSource: McpCaller,      // DataSource seam
    private tools: McpToolDef[],
  ) {}
  list(): ToolDefinition[] { /* map to aptkit's shape */ }
  async execute(toolCall): Promise<ModelToolResultBlock> {
    const { result, durationMs, fromCache } =
      await this.dataSource.callTool(toolCall.name, toolCall.input);
    // wrap result; if error, set is_error: true
    return { type: 'tool_result', tool_use_id, content: [...], is_error };
  }
}
```

Two important things:

1. **The registry doesn't know which DataSource is behind it.** McpDataSource, SyntheticDataSource, FaultInjectingDataSource — all look identical to the registry. That's the DataSource port paying off (see `lib/data-source/types.ts`).
2. **The `is_error` flag rides through.** When a tool fails (401, timeout, 500, malformed JSON), the registry sets `is_error: true` in the tool_result. The model sees the error as an observation and reasons around it. That's the graceful-degradation pattern (see **06-error-recovery.md**).

**The tool result is a message, not a return value.** The model doesn't receive a JavaScript return; it receives the *next message* in the conversation, whose role is `user` and content is a `tool_result` block. The loop appends this message and calls the model again with the extended messages array.

Diagram of one tool call round-trip:

```
  One tool call — layers-and-hops

  ┌─ model turn (turn N) ─┐  hop 1: tool_use in response ┌─ agent loop ──┐
  │ emits tool_use        │ ──────────────────────────► │               │
  └───────────────────────┘                             └──────┬────────┘
                                                          hop 2│ execute()
                                                               ▼
                                                        ┌─ registry ─────┐
                                                        │ Blooming...    │
                                                        │ ToolRegistry   │
                                                        │ Adapter        │
                                                        └──────┬─────────┘
                                                          hop 3│ callTool()
                                                               ▼
                                                        ┌─ DataSource ───┐
                                                        │ McpDataSource  │
                                                        └──────┬─────────┘
                                                          hop 4│ MCP protocol
                                                               ▼
                                                        ┌─ MCP server ───┐
                                                        │ Bloomreach     │
                                                        └──────┬─────────┘
                                                          hop 5│ result
                                                               ▼
                                                        wrapped as tool_result
                                                               │
  hop 6: append tool_result message ◄──────────────────────────┘
         next model turn (turn N+1)
```

### Move 3 — the principle

The LLM is the brain. Tools are the hands. Your code is the nervous system that carries signals between them. If you conflate them — try to make the model "run" a tool directly or embed logic in a tool's schema — you break the layering that makes the whole loop debuggable.

## Primary diagram

```
  Tool calling — full frame

  ┌─ Agent turn ────────────────────────────────────────────┐
  │                                                          │
  │  response.content =                                      │
  │    [ text, tool_use, text, tool_use, ... ]              │
  │           ▲                                              │
  │           │  each tool_use has { id, name, input }       │
  │                                                          │
  └───────────────────────┬─────────────────────────────────┘
                          │
                          ▼
  ┌─ For each tool_use ─────────────────────────────────────┐
  │  registry.execute(toolCall):                             │
  │    dataSource.callTool(name, input) → { result, ... }    │
  │    wrap as tool_result { tool_use_id, content,           │
  │                          is_error? }                     │
  └───────────────────────┬─────────────────────────────────┘
                          │
                          ▼
  ┌─ Append to messages, next turn ─────────────────────────┐
  │  messages.push({ role: 'user', content: tool_results })  │
  │  model.complete(messages)  // next turn                  │
  └─────────────────────────────────────────────────────────┘
```

## Elaborate

Tool calling was popularized by OpenAI's "function calling" API in 2023 and adopted with slight variation by every major provider. The name changed to "tool calling" as the pattern generalized beyond functions to include arbitrary side-effecting operations.

The pattern's key property: no free-form output from the model can bypass the tool schema. If the model wants to search PRs, it emits a `tool_use` with the search-tool schema. It can't just write "I'll search PRs" in text and expect anything to happen — the code needs the structured request.

Related: **../01-llm-foundations/04-structured-outputs.md** (the same schema-constrained decoding underpins tool calling and typed outputs), **06-error-recovery.md** (the `is_error: true` path).

## Project exercises

### B4.2 · Add a tool-call telemetry receipt

- **Exercise ID:** B4.2 (Case A — telemetry exists via trace sink; add per-tool aggregates)
- **What to build:** Extend the `BloomingTraceSinkAdapter` to accumulate per-tool-name stats — count, p50/p95 latency, error rate — over an investigation. Emit a summary event at the end of the run.
- **Why it earns its place:** Turns "we log tool calls" into "we know which tools dominate cost and which fail." Feeds directly into the observability report (`eval/report.eval.ts`).
- **Files to touch:** `lib/agents/aptkit-adapters.ts` (BloomingTraceSinkAdapter — accumulate per-tool stats), `lib/mcp/events.ts` (add `tool_summary` variant), `eval/report.eval.ts` (surface per-tool breakdown).
- **Done when:** the report prints a per-tool table per case: `execute_analytics_eql: 8 calls, p50=4200ms, 0 errors`.
- **Estimated effort:** `1–4hr`.

## Interview defense

**Q: What happens if the model emits a `tool_use` for a tool that doesn't exist?**

Anthropic's constrained decoding prevents this in the tool-use path — the model can only pick from the tools you declared in `MessageCreateParams.tools`. If somehow it did (via a hallucinated name), `BloomingToolRegistryAdapter.execute()` would fail the lookup and return `is_error: true` with a "tool not found" message; the model would observe the error and try a different tool. Load-bearing: the failure mode is graceful, not crashing.

**Q: Why relay the MCP tool's `inputSchema` verbatim instead of writing your own?**

Because the MCP server is the source of truth. If the tool's arguments change server-side, my code adapts automatically. If I redefined the schema, I'd have to keep two copies in sync. See `lib/agents/tool-schemas.ts:9` — the `filterToolSchemas` helper only *filters* the set; it doesn't invent schemas.

## See also

- [03-react-pattern.md](03-react-pattern.md) — the loop this call runs inside.
- [../01-llm-foundations/04-structured-outputs.md](../01-llm-foundations/04-structured-outputs.md) — the schema constraint that makes tool_use safe.
- [06-error-recovery.md](06-error-recovery.md) — where `is_error: true` shines.

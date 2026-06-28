# 02 — tool calling

**Subtitle:** `tool_use` / `tool_result` message exchange · Industry standard (load-bearing)

## Zoom out, then zoom in

When the model wants to take action, it emits a `tool_use` content block
in its response. Blooming runs the tool, sends the result back as a
`tool_result` user message, and the loop continues. The wire-shape is
defined by Anthropic; the adapter in this codebase is
`BloomingToolRegistryAdapter`.

```
  Zoom out — tool-calling is the agent loop's one mechanism

  ┌─ adapter.complete(req) returns ─────────────────┐
  │   content: [                                    │
  │     { type: 'tool_use', id, name, input } ★    │  ← we are here
  │   ]                                             │
  └─────────────────┬───────────────────────────────┘
                    │
                    ▼
  ┌─ AptKit dispatches → BloomingToolRegistryAdapter ┐
  │   callTool(name, input, {signal})                │
  └─────────────────┬────────────────────────────────┘
                    │
                    ▼
  ┌─ DataSource.callTool (Bloomreach or synthetic) ──┐
  │   live MCP request OR synthetic fake             │
  └─────────────────┬────────────────────────────────┘
                    │ result
                    ▼
  ┌─ AptKit appends to history ──────────────────────┐
  │   { role: 'user', content: [                     │
  │     { type: 'tool_result', tool_use_id, content }│
  │   ]}                                             │
  └──────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — capability.** The model can ASK for a tool to
    run; it cannot RUN one. Blooming's code is the only thing that can
    actually execute side effects. The model is the brain; Blooming's
    code is the hands. This separation is what makes the system
    inspectable and secure.

  → **Two seams:**
    1. AptKit ↔ BloomingToolRegistryAdapter (provider-neutral tool
       interface).
    2. BloomingToolRegistryAdapter ↔ DataSource (Bloomreach or synthetic).

## How it works

### Move 1 — the mental model

The model decides; your code runs. The wire format is structured: a
`tool_use` block names the tool and supplies typed arguments matching the
tool's input schema. Your code dispatches, runs the tool, packs the
result as a `tool_result` block, and the next model turn sees it.

```
  One turn of the loop, broken open

  Anthropic API returns:
    {
      content: [
        { type: 'tool_use',
          id: 'toolu_01abc',
          name: 'execute_analytics_eql',
          input: { project_id: '...', eql: 'select count event ...' } }
      ],
      stop_reason: 'tool_use'
    }

  Blooming runs the tool, then sends back NEXT turn:
    {
      role: 'user',
      content: [
        { type: 'tool_result',
          tool_use_id: 'toolu_01abc',
          content: '{ "rows": [...] }' }
      ]
    }
```

### Move 2 — the step-by-step walkthrough

**Step 1 — tool definitions are passed in the request.** Look at
`AnthropicModelProviderAdapter.complete()`
(`lib/agents/aptkit-adapters.ts:42-71`):

```typescript
if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);
```

The `request.tools` is `ModelTool[]` — AptKit's provider-neutral shape.
`toAnthropicTool` (line 179) converts each to Anthropic's `Tool` shape:

```typescript
function toAnthropicTool(tool: ModelTool): Anthropic.Messages.Tool {
  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema as Anthropic.Messages.Tool['input_schema'],
  };
}
```

So the model sees each tool's name, description, and JSON Schema for its
arguments. With this, the model can emit `tool_use` blocks whose `input`
matches the schema.

**Step 2 — tool definitions come from the data source.** Inside each
agent's constructor, `allTools: McpToolDef[]` is passed in. These come
from `dataSource.listTools()` in the route handler
(`app/api/agent/route.ts:239-242`):

```typescript
const rawTools = await dataSource.listTools({ signal: req.signal });
const allTools: McpToolDef[] = Array.isArray((rawTools as { tools?: unknown })?.tools)
  ? (rawTools as { tools: McpToolDef[] }).tools
  : [];
```

For Bloomreach mode, `listTools` queries the MCP server for its tool
list. For synthetic mode, it returns the pre-defined synthetic tool list
(`lib/data-source/synthetic-data-source.ts`). Either way, the result is
a typed list of tools the agent could call.

**Step 3 — per-agent allowlists narrow the list.** AptKit's agent
classes accept the full tool list AND a per-agent filter. The filter is
derived from `lib/mcp/tools.ts`'s allowlists (`monitoringTools`,
`diagnosticTools`, etc.). The agent only ever sees its own subset.

Each per-agent allowlist is intentionally tight:
  - `monitoringTools` (13) — read-only analytics tools.
  - `diagnosticTools` (17) — analytics + customer/campaign lookups for
    hypothesis testing.
  - `recommendationTools` (8) — feature-discovery tools (scenarios,
    segments, voucher pools).
  - `queryTools` (~22, union) — everything, for the free-form agent.

A monitoring agent cannot call `list_email_campaigns`; that's a
recommendation tool. The narrowing happens in AptKit when it builds
the per-call tool list (filters `allTools` down to the allowlist).

**Step 4 — the model emits `tool_use`; the adapter dispatches.**
`BloomingToolRegistryAdapter.callTool` (`lib/agents/aptkit-adapters.ts:89-96`):

```typescript
async callTool(
  name: string,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<{ result: unknown; durationMs: number }> {
  const { result, durationMs } = await this.dataSource.callTool(name, args, options);
  return { result, durationMs };
}
```

That's the whole adapter. It hands the call straight to
`this.dataSource.callTool` (which is `BloomreachDataSource.callTool` in
live mode — see `06-production-serving/04-rate-limiting-backpressure.md`
for the rate-limit / retry / cache layer underneath). The `signal` is
passed through so cancellation works end to end.

**Step 5 — the trace sink emits the call event.** The
`BloomingTraceSinkAdapter` (`lib/agents/aptkit-adapters.ts:100-141`)
catches `tool_call_start` and `tool_call_end` events and converts them
to Blooming `ToolCall` objects:

```typescript
emit(event: CapabilityEvent): void {
  if (event.type === 'step') {
    this.hooks.onText?.(event.content);
    return;
  }
  if (event.type === 'tool_call_start') {
    const toolCall = this.toBloomingToolCall(event);
    const existing = this.activeToolCalls.get(event.toolName) ?? [];
    existing.push(toolCall);
    this.activeToolCalls.set(event.toolName, existing);
    this.hooks.onToolCall?.(toolCall);
    return;
  }
  if (event.type === 'tool_call_end') {
    const toolCall = this.activeToolCalls.get(event.toolName)?.shift()
                  ?? this.toBloomingToolCall(event);
    toolCall.durationMs = event.durationMs;
    toolCall.result = event.result;
    toolCall.error = event.error;
    this.hooks.onToolResult?.(toolCall);
  }
}
```

The `activeToolCalls` map is a queue per tool name — it pairs `start`
events with their corresponding `end` events even when multiple calls
to the same tool are in flight (rare but happens with parallel tool
calls in newer Anthropic models). The route's `hooksFor()` callbacks
then `send({ type: 'tool_call_start', toolName, agent })` to the NDJSON
stream so the UI updates.

**Step 6 — AptKit packages the result as a `tool_result` message and
loops back.** Blooming doesn't see this part — it happens inside AptKit.
The next call to `adapter.complete()` includes the tool_use AND the
tool_result in `messages`, the model sees its previous request and the
data it got back, and decides the next move.

### Move 3 — the principle

**Tool calling is a typed RPC between the model and your code. The
model owns the decision; your code owns the execution; the schema is
the contract.** The model never executes side effects directly — it
asks, your code runs. This separation is what makes tool calls auditable
(every call shows up in the trace), allowlist-able (per-agent tool
subsets), and reversible (you can decide NOT to run a requested tool,
sending back an error result instead).

## Primary diagram

```
  Tool calling end-to-end — one round trip

  ┌─ AptKit agent loop (turn N) ───────────────────────────┐
  │                                                        │
  │  adapter.complete(req)                                 │
  │       │                                                │
  │       ▼  HTTPS to api.anthropic.com                    │
  │  response.content: [                                   │
  │    { type: 'tool_use', id: 'toolu_X',                  │
  │      name: 'execute_analytics_eql',                    │
  │      input: { project_id, eql } }                      │
  │  ]                                                     │
  │       │                                                │
  │       ▼                                                │
  │  for each tool_use block:                              │
  │    traceSink.emit({type: 'tool_call_start', …})        │
  │       │                                                │
  │       ▼                                                │
  │    result = await toolRegistry.callTool(name, input)   │
  │       │                                                │
  │       ▼  BloomingToolRegistryAdapter.callTool          │
  │    dataSource.callTool(name, input, {signal})          │
  │       │                                                │
  │       ▼  BloomreachDataSource (cache + rate limit)     │
  │    transport.callTool → MCP server → response          │
  │       │                                                │
  │       ▼                                                │
  │    traceSink.emit({type: 'tool_call_end', durationMs,  │
  │                    result})                            │
  │       │                                                │
  │       ▼                                                │
  │    history.append(                                     │
  │      user: { type: 'tool_result',                      │
  │              tool_use_id: 'toolu_X',                   │
  │              content: stringify(result) })             │
  │                                                        │
  │  next turn: adapter.complete(req) ◄──────────────────  │
  │                                                        │
  └────────────────────────────────────────────────────────┘
```

## Elaborate

Anthropic's `tool_use` / `tool_result` content blocks (May 2024 / Sonnet
3.5 era) are now the canonical tool-calling shape. OpenAI's
`tool_calls` (function calling) is the parallel; Google's Gemini has
similar. The shape is converging across providers, which is what makes
AptKit's `ModelTool` / `ModelContentBlock` provider-neutral abstraction
work — the underlying providers are all roughly the same shape.

The choice to put the allowlist in `lib/mcp/tools.ts` rather than in the
prompt is deliberate. Prompts can be ignored ("you can use tool X" → the
model uses tool Y anyway sometimes). An allowlist enforced at the
adapter level cannot be ignored — the model simply doesn't see tool Y
in its tool list. Defense in depth: the prompt also says "use only
these tools," but the adapter is what makes it true.

## Project exercises

### Exercise — enforce per-agent allowlists with a runtime assert

  → **Exercise ID:** `study-ai-eng-04-02.1`
  → **What to build:** In `BloomingToolRegistryAdapter.callTool`, before
    dispatching, assert `name` is in the allowed set. Currently this is
    handled by AptKit filtering the list before exposing to the model,
    but a defense-in-depth assertion at the dispatch site would catch
    AptKit bugs and prompt-injection attempts where the model fabricates
    a tool name not in its visible list.
  → **Why it earns its place:** Defense in depth. The allowlist is
    currently enforced by "the model can't see the tool"; an explicit
    runtime check is the belt to that suspenders.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts:89-96`, each
    agent (pass allowlist into the adapter constructor), tests.
  → **Done when:** A unit test calling
    `adapter.callTool('list_email_campaigns', {})` against a monitoring
    agent's adapter throws an "tool not in allowlist" error.
  → **Estimated effort:** `1–4hr`

## Interview defense

**Q: How does the model call tools in this codebase?**

Anthropic's `tool_use` / `tool_result` message exchange.

```
  turn N:
    model response.content: [{type: 'tool_use', id, name, input}]
       ↓ BloomingToolRegistryAdapter.callTool(name, input)
       ↓ dataSource.callTool(name, input)
       ↓ BloomreachDataSource → MCP server
       ↓ result
       ↑ trace event emitted to NDJSON
  turn N+1:
    history.append({role: 'user', content: [{type: 'tool_result',
                                              tool_use_id: id,
                                              content: stringify(result)}]})
    next adapter.complete() sees both blocks; model decides next move
```

The model NEVER runs the tool. It asks; Blooming's code runs. That
separation is what makes the system inspectable (every call is traced)
and allowlist-able (per-agent tool subsets in `lib/mcp/tools.ts`).

**Anchor line:** "The model is the brain; the code is the hands. The
adapter is the API between them."

**Q: What's the load-bearing detail in `BloomingToolRegistryAdapter`?**

It's tiny — 8 lines (`lib/agents/aptkit-adapters.ts:89-96`) — but it's
the seam between AptKit's provider-neutral world and Blooming's
data-source world. The thing it gets right: passing `signal` through to
`dataSource.callTool`. Without that, MCP requests don't cancel when the
browser navigates away, and the 300s route budget gets eaten by
abandoned in-flight calls.

**Anchor line:** "Eight lines, but the signal passthrough is the load-
bearing one. Drop it and cancellation breaks."

## See also

  → `01-agents-vs-chains.md` — the loop the tool call sits inside
  → `04-tool-routing.md` — how the per-agent allowlists are picked
  → `06-production-serving/04-rate-limiting-backpressure.md` — the layer
    BELOW `dataSource.callTool` that handles MCP rate limits

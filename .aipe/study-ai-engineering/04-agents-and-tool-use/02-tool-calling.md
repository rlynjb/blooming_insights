# 02 — Tool calling

**Type:** Industry standard. Also called: function calling, tool_use blocks, structured actions.

## Zoom out, then zoom in

The mechanism at the heart of every agent in this codebase. Model emits a `tool_use` block; code dispatches; result comes back as a `tool_result` block; loop continues.

```
  Zoom out — where tool-call sits

  ┌─ Agent loop (AptKit) ─────────────────────────────────────────────┐
  │  model emits tool_use    ← ★ THIS CONCEPT ★                        │
  │       ↓                                                            │
  │  BloomingToolRegistryAdapter.callTool(name, args)                  │
  │       ↓                                                            │
  │  DataSource seam                                                   │
  │       ↓                                                            │
  │  Bloomreach MCP  /  Synthetic  /  FaultInjecting                   │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. Every "action" the agent takes — every EQL query, every `list_customers` fetch — is a tool_use block that AptKit's loop translates into a real call through the tool registry adapter. The model doesn't run the tool; code does. The model asks; code answers.

## Structure pass

**Layers:**
- Outer: the agent's decision to fetch something
- Middle: `tool_use` block + tool registry dispatch
- Inner: the concrete tool call (MCP over HTTP, or synthetic in-memory)

**Axis: who runs the tool?**
- Above the seam (model side): the LLM emits a structured request but cannot execute anything
- Below the seam (code side): the registry dispatches, the DataSource runs the tool, the result comes back

**Seam:** `ToolRegistry.callTool(name, args)`. Above: model + AptKit's loop. Below: `BloomingToolRegistryAdapter` + `DataSource` (Bloomreach/Synthetic/FaultInjecting).

## How it works

### Move 1 — the mental model

You've registered event handlers on a DOM element — `onclick`, `onsubmit`. The DOM says "the user clicked"; your handler runs. Tool calling is the same shape at the LLM boundary: the model says "run this tool with these args"; your code runs; the result is handed back on the next turn.

```
  Tool call as a structured request

  model turn N       code (agent loop)                      turn N+1
  ─────────────       ─────────────                          ────────
  emits:
    tool_use {                                              messages get:
      id: 'abc',                                              tool_result {
      name: 'execute_analytics_eql',                            tool_use_id: 'abc',
      input: {query: '…', project_id: '…'}                     content: '…json…'
    }                                                         }
                       ↓
                    ToolRegistry.callTool('execute_analytics_eql', {…})
                       ↓
                    DataSource.callTool('execute_analytics_eql', {…})
                       ↓
                    HTTP call to Bloomreach MCP
                       ↓
                    result envelope {isError, content, structuredContent}
                       ↑
                       └── wrapped as tool_result block
```

### Move 2 — walk the mechanism

**The tool registry adapter.**

`BloomingToolRegistryAdapter` at `lib/agents/aptkit-adapters.ts:124-146` implements AptKit's `ToolRegistry` interface. Two methods:

```typescript
// lib/agents/aptkit-adapters.ts:124-146
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

The adapter is tiny — 20 lines. All it does is forward the AptKit call shape into the DataSource call shape. Because the DataSource port is deliberately close to what the agent needs, the adapter has nothing to do.

**The DataSource seam.**

Three implementations of `DataSource` (defined in `lib/data-source/types.ts:63-71`):
- `BloomreachDataSource` — live MCP over the alpha loomi connect server. Rate-limited (~1 req/s), cached (60s), retries on the server's stated window.
- `SyntheticDataSource` — in-memory deterministic fixture. Used by the eval harness. Every call returns pre-computed data matching the tool + args, in a shape identical to Bloomreach.
- `FaultInjectingDataSource` — decorator over any DataSource. Wraps every `callTool()` and forces failures at configurable rates (timeout, rate limit, server error, malformed JSON).

The `DataSource` port has survived three adapter changes (Olist added → removed, Synthetic added, FaultInjecting decorator added) with no caller changes. That's the seam's value — the agent loop doesn't know or care what's on the other side.

**Where the model sees the tools.**

Every model turn re-sends the tools list. `AptKit`'s loop calls `toolRegistry.listTools()`, feeds into `ModelRequest.tools`, adapter forwards to Anthropic's `tools` param. The model's `input_schema` is what constrains which shapes `tool_use` blocks can take.

**The two shapes of MCP tool response.**

MCP tools return an envelope: `{isError?: boolean, content?: [{type, text}], structuredContent?: unknown}`. The unwrap logic (`lib/mcp/schema.ts`) prefers `structuredContent` when present, falls back to parsing `content[0].text`. That's the "MCP result envelope handling" the project context calls out as "must not change."

**The 6-tool-call cap in the prompt.**

The retired diagnostic prompt (`lib/agents/legacy-prompts/diagnostic.md:11`) is explicit: "Make at most 6 tool calls, then conclude." AptKit's built-in agent prompt has a similar bound. This isn't a hard cap in code — it's a soft cap in the prompt that the model respects. The soft cap keeps context growth bounded (`02-context-and-prompts/01-context-window.md`) AND keeps investigation cost bounded (~$0.09/case).

### Move 3 — the principle

Model asks; code answers. The tool_use / tool_result mechanism is a structured, typed handoff. The model doesn't run anything; it emits a request that code intercepts, dispatches, and hands back the result. Everything about tool safety, tool observability, tool cost tracking, tool failure handling — it all lives in your code, not in the model. Which is what you want.

## Primary diagram

The full tool-call path in this codebase.

```
  Tool call — one round trip

  ┌─ Model (turn N) ──────────────────────────────────────────────────┐
  │  response.content = [                                              │
  │    {type: 'text', text: 'checking payment_failure rates…'},        │
  │    {type: 'tool_use', id: 'toolu_abc',                             │
  │     name: 'execute_analytics_eql',                                 │
  │     input: {query: '…', project_id: '…', time_range: {…}}}         │
  │  ]                                                                 │
  └────────────────────────────┬──────────────────────────────────────┘
                               │
  ┌─ AptKit loop dispatch ─────▼──────────────────────────────────────┐
  │  for (const block of response.content) {                           │
  │    if (block.type === 'tool_use') {                                │
  │      trace.emit({type: 'tool_call_start', toolName, args, ts});    │
  │      const {result, durationMs} =                                  │
  │        await tools.callTool(block.name, block.input, {signal});    │
  │      trace.emit({type: 'tool_call_end', toolName, durationMs, result});│
  │      pending.push({toolUseId: block.id, result});                  │
  │    }                                                               │
  │  }                                                                 │
  └────────────────────────────┬──────────────────────────────────────┘
                               │
  ┌─ BloomingToolRegistryAdapter ─▼───────────────────────────────────┐
  │  callTool(name, args, opts) {                                      │
  │    return this.dataSource.callTool(name, args, opts);              │
  │  }                                                                 │
  └────────────────────────────┬──────────────────────────────────────┘
                               │
  ┌─ DataSource (one of three) ▼──────────────────────────────────────┐
  │  BloomreachDataSource        Live MCP over HTTP                    │
  │  SyntheticDataSource         In-memory fixture (evals)             │
  │  FaultInjectingDataSource    Decorator forcing failures            │
  └────────────────────────────┬──────────────────────────────────────┘
                               │  {result, durationMs, fromCache}
  ┌─ Turn N+1 messages array ──▼──────────────────────────────────────┐
  │  messages.push({                                                   │
  │    role: 'user',                                                   │
  │    content: [{                                                     │
  │      type: 'tool_result',                                          │
  │      tool_use_id: 'toolu_abc',                                     │
  │      content: JSON.stringify(result),                              │
  │      ...(result.isError ? {isError: true} : {})                    │
  │    }]                                                              │
  │  });                                                               │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

Tool calling as a first-class API primitive arrived in mid-2023 (OpenAI's function_call, Anthropic's tool_use). Before that, "tools" were prompt-engineered — the model would emit text like `TOOL: search_query {"q":"…"}` and the app would regex-parse it. Fragile. The move to native structured tool support removed a whole class of parse-time bugs (`01-llm-foundations/04-structured-outputs.md`).

The tool_use pattern also enabled MCP (Model Context Protocol, Anthropic's open standard for exposing tools to any LLM). MCP is what `blooming_insights` uses to talk to Bloomreach — it's tool-calling standardized across a network protocol.

## Project exercises

### Exercise — measure tool-call efficiency per case

- **Exercise ID:** C4.2-A · Case A (concept exercised).
- **What to build:** the receipts already log tool_calls per case. Add a report metric: mean tool calls per case, per signal class. On has-signal cases, mean should be < 4. On no-signal, mean should be low too (agent should give up quickly). Alert if mean rises above threshold across a run — signals prompt drift.
- **Why it earns its place:** turns "the 6-call cap" claim into a measured discipline. Interviewer signal: "I know exactly how many tools each case uses, and I have a drift alert when it changes."
- **Files to touch:** `eval/report.eval.ts` (add tool-call efficiency section), `eval/gate.eval.ts` (extend regression check).
- **Done when:** running `npm run eval:report` prints a "tool calls per case" table by signal class, and `npm run eval:gate` fails if mean tool calls rises by > 20%.
- **Estimated effort:** 1-4hr.

## Interview defense

**Q: Can the model run tools?**

No. The model emits a structured `tool_use` block with a name and args. My code — specifically AptKit's loop calling my `BloomingToolRegistryAdapter` — is what actually runs the tool. Result comes back as a `tool_result` block that goes into the next message. Model is the brain; my code is the hands.

**Q: What's the shape of a tool call?**

Three pieces. (1) Tool definition — name + description + JSON Schema for input, sent to the model as part of every turn. (2) Model output — `tool_use {id, name, input}` block, where `input` is guaranteed to conform to the schema. (3) Code side — dispatch by name, run the tool, wrap the response as `tool_result {tool_use_id, content, isError?}` in the next message. The loop iterates on that.

```
  tool_use → tools.callTool() → tool_result → tool_use → ...
    (model)    (my code)         (my code)     (model)
```

**Q: What is the DataSource seam and why does it matter?**

It's the port between the tool registry adapter and any concrete tool backend. Three implementations today: Bloomreach (live MCP), Synthetic (deterministic fixture for evals), FaultInjecting (decorator for load / fault tests). The agent code depends on the port, never on a specific backend. Same agents run against live production, against synthetic fixtures, against synthetic-with-injected-faults — all without a caller-side change. That's what the seam is for.

## See also

- `03-react-pattern.md` — the loop the tool_use lives inside
- `01-llm-foundations/04-structured-outputs.md` — the schema-constrained boundary
- `06-error-recovery.md` — what happens when a tool_call fails
- `lib/agents/aptkit-adapters.ts:124-146` — the ToolRegistry adapter
- `lib/data-source/types.ts` — the DataSource port

# 04 — AptKit agent primitive boundary

**Industry name:** adapter pattern between an in-house application and an extracted reusable primitive. *Type: Industry standard.*

## Zoom out, then zoom in

The agent loop (ReAct with tool-use) is the same shape in every
AI-agent app. This repo used to own its own implementation; now
it depends on `@aptkit/core@0.3.0`, which owns the reusable
primitive, and this repo owns three thin adapters that bridge
between AptKit's provider-neutral vocabulary and Blooming's
specifics — Anthropic SDK for models, Bloomreach tool defs, the
`AgentEvent` NDJSON contract.

```
  Zoom out — where the AptKit boundary sits

  ┌─ Service layer (route handler) ─────────────────────────┐
  │  /api/briefing · /api/agent                             │
  │  wraps agent invocation, streams AgentEvents             │
  └──────────────────────┬──────────────────────────────────┘
                         │  monitoring.scan() / diagnostic.run() / …
  ┌─ Agent facades (lib/agents/*.ts) ────────────────────────┐
  │  monitoring · diagnostic · recommendation · query        │
  │  configure AptKit, own the streaming hooks               │
  └──────────────────────┬──────────────────────────────────┘
                         │  ★ boundary: aptkit-adapters.ts (3 classes) ★
  ┌─ AptKit primitive (@aptkit/core@0.3.0) ─────────────────┐
  │  runAgentLoop — ReAct-style think→tool→observe kernel   │
  │  ModelProvider · ToolRegistry · CapabilityTraceSink     │
  └──────────────────────┬──────────────────────────────────┘
                         │  provider-neutral surface
  ┌─ Concrete providers (Blooming-owned adapters) ──────────┐
  │  Anthropic SDK  ·  DataSource (McpDataSource/Synthetic) │
  └─────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is Adapter (GoF). AptKit exposes
three interfaces (`ModelProvider`, `ToolRegistry`,
`CapabilityTraceSink`); this repo implements each one against
its concrete provider. The interesting part is what rides the
seam: budget threading, the capability event hook, and prompt
caching all live in the adapter — because they're this repo's
concerns, not AptKit's.

## Structure pass

Two layers (this repo / AptKit), one axis: **who owns the
model-agnostic vs model-specific concerns?**

```
  Axis "who owns this concern?" — trace it across the boundary

  ┌─ Blooming ───────────────────────────────────────────────┐
  │ owns:  Anthropic SDK, model names, cache_control shape,  │
  │        DataSource callTool signature, AgentEvent NDJSON, │
  │        BudgetTracker, capability-event hook consumers    │
  └──────────────────────┬───────────────────────────────────┘
                         │  seam: 3 adapter classes
  ┌─ AptKit ──────────────▼──────────────────────────────────┐
  │ owns:  ReAct loop (think → tool → observe → repeat),     │
  │        max-iteration budget, tool-schema shape,          │
  │        message-role vocabulary (ModelMessage/            │
  │        ModelContentBlock), CapabilityEvent trace shape   │
  └──────────────────────────────────────────────────────────┘
```

The seam is the three-class contract in
`lib/agents/aptkit-adapters.ts` (263 LOC). Above it, this repo
holds vendor-specific everything. Below it, AptKit only sees
provider-neutral shapes. That's why "who owns this concern?"
flips cleanly at this boundary — every Anthropic-specific
detail lives above; every generic agent-loop detail lives
below.

## How it works

### Move 1 — the mental model

You've used `axios.create({ baseURL, headers })` — you're
adapting one function-shape (an HTTP client with a specific
config) to fit another (your app's caller vocabulary). Same
idea here, at the primitive-library boundary. AptKit exports
interfaces; you implement them against your specific stack.

```
  Pattern — the three-adapter boundary

  ┌─ @aptkit/core exports interfaces ────────────────────┐
  │   ModelProvider       .complete(request)              │
  │   ToolRegistry        .listTools() / .callTool(...)   │
  │   CapabilityTraceSink .emit(event)                    │
  └────────────────────┬─────────────────────────────────┘
                       │ implemented by (this repo)
      ┌────────────────┼────────────────┐
      ▼                ▼                ▼
  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
  │ Anthropic-   │ │ Blooming-    │ │ Blooming-    │
  │ ModelProvider│ │ ToolRegistry │ │ TraceSink    │
  │ Adapter      │ │ Adapter      │ │ Adapter      │
  │              │ │              │ │              │
  │ anthropic.   │ │ dataSource.  │ │ hooks.       │
  │  messages    │ │  callTool    │ │  onText/     │
  │  .create()   │ │              │ │  onToolCall/ │
  │              │ │              │ │  onCapability│
  │ + budget     │ │              │ │              │
  │ + cache_ctrl │ │              │ │              │
  └──────────────┘ └──────────────┘ └──────────────┘
```

### Move 2 — step by step

**Part 1: adapter A — the model provider.** Wraps Anthropic's
SDK. Two things ride the seam here that aren't AptKit's
concern: budget checking and prompt caching.

```ts
// lib/agents/aptkit-adapters.ts:59-121  (annotated skeleton)
async complete(request: ModelRequest): Promise<ModelResponse> {
  // Budget gate — check BEFORE dispatching; refuse to spend if the
  // ceiling has already been hit. Route handler catches and emits
  // a graceful NDJSON error event.
  if (this.budget?.exceeded()) {
    throw new BudgetExceededError(this.budget.snapshot(), this.budget.limit);
  }

  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: this.defaultModel,
    max_tokens: request.maxTokens ?? 4096,
    messages: request.messages.map(toAnthropicMessage),
  };

  // Prompt caching — the system prompt is stable across every model
  // turn in the ~10-turn ReAct loop. Wrapping it in an ephemeral
  // cache breakpoint makes turn 1 cache_creation (~1.25×) and
  // turns 2-10 cache_read (~0.1×). Tools ride along transparently.
  if (request.system) {
    params.system = [
      { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
    ];
  }
  if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);

  const response = await this.anthropic.messages.create(
    params, request.signal ? { signal: request.signal } : undefined,
  );

  // Accumulate usage into the tracker so subsequent turns see the total.
  this.budget?.add({
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });

  return {
    content: response.content.flatMap(toModelContentBlock),
    usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    model: response.model,
  };
}
```

Three details worth naming. First, the budget gate throws
*before* the API call — a runaway loop can't burn additional
cost after the ceiling is hit. Second, `cache_control` lives on
this side of the seam because it's Anthropic-specific (AptKit
doesn't know about ephemeral cache blocks). Third, the tracker
undercounts cache-read tokens (aptkit's `model_usage` event
doesn't expose the cache-tier breakdown) — the check is
deliberately conservative.

**Part 2: adapter B — the tool registry.** Bridges AptKit's
tool-call surface to `DataSource.callTool`.

```ts
// lib/agents/aptkit-adapters.ts:123-146
export class BloomingToolRegistryAdapter implements ToolRegistry {
  constructor(
    private readonly dataSource: McpCaller,     // ← DataSource slice
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

`McpCaller` at `lib/agents/base.ts:14` is a narrower type than
`DataSource` — it's `Pick<DataSource, 'callTool'>`. This is
the "callee interface segregation" move: the agent adapter
doesn't need `listTools` (that's supplied via `allTools`), so
the constructor asks only for what it uses. Feature envy caught
at the type level.

**Part 3: adapter C — the trace sink.** Bridges AptKit's
`CapabilityEvent` union into this repo's per-event hooks.

```ts
// lib/agents/aptkit-adapters.ts:149-196  (skeleton)
export class BloomingTraceSinkAdapter implements CapabilityTraceSink {
  private readonly activeToolCalls = new Map<string, ToolCall[]>();

  constructor(
    private readonly hooks: AptKitAgentHooks,
    private readonly agent: AgentName,
  ) {}

  emit(event: CapabilityEvent): void {
    // Phase-2 observability: forward every event to the optional
    // capability-event hook first. Consumers that don't set it
    // see identical behavior.
    this.hooks.onCapabilityEvent?.(event);

    if (event.type === 'step')            { this.hooks.onText?.(event.content); return; }
    if (event.type === 'tool_call_start') { /* stash, then onToolCall */ return; }
    if (event.type === 'tool_call_end')   { /* fill result, then onToolResult */ }
  }
}
```

The additive `onCapabilityEvent` hook is the seam that lets the
eval harness feed events into aptkit's `summarizeUsage` +
`estimateCost` for per-invocation token + cost ledger rows —
without perturbing route/UI consumers that only care about
text and tool calls.

**Part 4: the budget rides through the seam.** The tracker is
created once per investigation by the caller (route or eval
runner), passed as a constructor arg to the adapter, and read
before every model turn.

```
  Layers-and-hops — budget threading

  ┌─ route handler ─────────┐  hop 1: new BudgetTracker({ maxCostUsd })
  │  new BudgetTracker(...) │
  └───────────┬─────────────┘
              │
  ┌─ adapter ─▼─────────────┐  hop 2: passed as ctor arg
  │  AnthropicModelProvider │
  │  Adapter(anthropic,     │
  │          agent, sid,    │
  │          model, logSite,│
  │          budget)        │
  └───────────┬─────────────┘
              │ each .complete() call:
              ▼
       exceeded?  → throw BudgetExceededError
              │
              ▼
       add(usage) after response
              │
  ┌─ error path ▼────────────┐  hop 3: route catches, emits
  │  { type: 'error',        │  graceful NDJSON error event
  │    message: '...' }      │
  └─────────────────────────┘
```

**Part 5: capability events ride out to observability.** The
optional `onCapabilityEvent` hook is what makes the observability
layer work without changing the route/UI path.

```
  Pattern — one event stream, two consumer paths

  aptkit emits CapabilityEvent
              │
     BloomingTraceSinkAdapter.emit
              │
     ┌────────┴────────────────────────┐
     ▼                                 ▼
  onCapabilityEvent (optional)   per-type routing (default)
     │                                 │
     ▼                                 ▼
  eval harness →                  onText / onToolCall /
  summarizeUsage +                onToolResult →
  estimateCost →                  route streams NDJSON
  ledger rows                     to browser
```

### Move 3 — the principle

When you extract a reusable primitive from an application, the
adapter layer is where you decide *what stays specific*.
Everything the primitive can reasonably own (the loop, the
message vocabulary, the trace shape) moves down. Everything the
app cares about but the primitive shouldn't know (vendor SDK
shape, cost accounting, custom observability) stays in the
adapter. The measure of a good adapter is that neither side
needs to know about the other's concerns — a truth this repo
paid for by keeping cache_control, budget, and NDJSON
conversion on the Blooming side of the seam.

## Primary diagram

```
  AptKit boundary recap — one investigation turn

  ┌─ Route handler ─────────────────────────────────────┐
  │  new BudgetTracker({ maxCostUsd: 0.30 })            │
  │  new DiagnosticAgent(dataSource, budget)            │
  │  await agent.run(insight, {                         │
  │    onText: (t) => send({type:'reasoning_step',...}),│
  │    onToolCall: (tc) => send({type:'tool_call_start',│
  │    onCapabilityEvent: (e) => ledger.record(e),      │
  │  })                                                 │
  └────────────────────┬────────────────────────────────┘
                       │
  ┌─ Agent facade ─────▼────────────────────────────────┐
  │  const model = new AnthropicModelProviderAdapter(   │
  │    anthropic, agent, sid, MODEL, logSite, budget    │
  │  );                                                 │
  │  const registry = new BloomingToolRegistryAdapter(  │
  │    dataSource, diagnosticTools                       │
  │  );                                                 │
  │  const trace = new BloomingTraceSinkAdapter(hooks, agent);│
  │                                                     │
  │  await runAgentLoop({ model, registry, trace, ... });│
  └────────────────────┬────────────────────────────────┘
                       │ ★ seam: 3 adapter classes ★
  ┌─ @aptkit/core ─────▼────────────────────────────────┐
  │  loop:                                              │
  │    while iteration < max:                           │
  │      trace.emit({type:'step', content: reasoning})  │
  │      resp = await model.complete(request)           │
  │      if resp.hasToolCalls:                          │
  │        for each tc:                                 │
  │          trace.emit({type:'tool_call_start', ...})  │
  │          result = await registry.callTool(...)      │
  │          trace.emit({type:'tool_call_end', ...})    │
  │      else:                                          │
  │        return resp.text                             │
  └─────────────────────────────────────────────────────┘
```

## Elaborate

Extracting `@aptkit/core@0.3.0` from this codebase is the
straightforward version of the Strangler-Fig pattern applied
inward. Instead of migrating away from legacy code, the app
learned which of its parts were generic enough to live in a
library, extracted them, and left the specifics behind through
adapters. The receipt is the pre-extraction agent code still
sitting next to the new adapters — `base-legacy.ts`,
`monitoring-legacy.ts`, etc., in `lib/agents/`. Those files are
the "before" snapshot; the aptkit-adapter pathway is the
"after."

Where the adapter pattern shows up elsewhere: pgvector's
`Embeddings` interface (any embedding provider fits), LangChain's
tool interface (any tool fits), Vercel's AI SDK's model
provider adapters. The pattern is boring; the interesting
question is always "what stays on each side, and why?"

## Interview defense

**Q: Why not just call the Anthropic SDK from the agents
directly?**

A: Because the loop mechanics — the ReAct think/tool/observe
cycle, tool-call parsing, iteration budgeting — are the same
in every AI-agent app. Owning them here means writing +
testing + maintaining them here. Extracting to
`@aptkit/core` means one place to fix bugs, one place to add
capabilities like the capability trace. The adapter layer is
the price.

**Q: What rides on the seam that isn't AptKit's concern?**

A: Three things: (1) prompt caching via `cache_control` on the
system prompt (Anthropic-specific), (2) the `BudgetTracker`
gate before each `complete()` call (Blooming's cost ceiling,
not AptKit's), (3) the additive `onCapabilityEvent` hook that
forwards to the observability ledger. All three could have
been pushed down into AptKit; they weren't, because they're
concerns this app has that other AptKit users wouldn't.

**Q: One part of this seam people forget?**

A: The `McpCaller` type on the tool-registry adapter's
constructor. It's `Pick<DataSource, 'callTool'>` — the adapter
asks for exactly what it uses, not the full DataSource. This
is interface segregation at the type level. The adapter can't
call `listTools` on the wrong thing because the type it
receives literally doesn't have that method.

**Q: When would you skip this pattern?**

A: When you have exactly one caller and no plan to extract.
The AptKit boundary earns its complexity because the loop
mechanics were already being duplicated across four agents.
Extracting them saved four maintenance points. If you had one
agent and one caller, the adapter would be pure ceremony.

## See also

- `03-provider-abstraction-and-datasource-seam.md` — the
  DataSource port the ToolRegistryAdapter reads through
- `05-streaming-ndjson.md` — where the trace sink's events end
  up on the wire
- `01-request-flow.md` — where the BudgetTracker gets constructed

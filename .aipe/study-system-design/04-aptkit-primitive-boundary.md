# aptkit-primitive-boundary

## Adapter pattern at the library boundary (industry standard)

The same port + adapter shape as the DataSource seam, applied one layer up — between this repo and `@aptkit/core@0.3.0`. The library owns the agent loop; this repo owns the boundary. Three adapter classes (206 LOC, all in `lib/agents/aptkit-adapters.ts`) bridge the library's three ports to this repo's primitives: the Anthropic SDK client, the `DataSource` port, and the route's NDJSON event hooks.

## Zoom out — where this pattern lives

This is the boundary that lets the agent loop be a library concern instead of a Blooming concern. Five active agent files (`monitoring.ts`, `diagnostic.ts`, `recommendation.ts`, `query.ts`, `intent.ts`) are now thin wrappers — each one builds the three adapters and calls a library agent's `scan(...)` or `run(...)`.

```
  Zoom out — where the AptKit boundary sits

  ┌─ Service layer (this repo) ────────────────────────────────────────┐
  │  routes        agents/*.ts (thin wrappers)         lib/data-source │
  │                       │                                             │
  │                       ▼                                             │
  │  ★ APTKIT BOUNDARY ★  3 adapter classes (lib/agents/aptkit-…ts)     │ ← we are here
  │   ┌────────────────────────────────────────────────────────────┐    │
  │   │ AnthropicModelProviderAdapter  → implements ModelProvider  │    │
  │   │ BloomingToolRegistryAdapter    → implements ToolRegistry   │    │
  │   │ BloomingTraceSinkAdapter       → implements CapabilityTraceSink │
  │   └────────────────────────────────────────────────────────────┘    │
  └────────────────────────┬───────────────────────────────────────────┘
                           │  the library consumes these ports
  ┌─ Library layer (@aptkit/core@0.3.0) ──────────────────────────────┐
  │  AnomalyMonitoringAgent · DiagnosticAgent · RecommendationAgent    │
  │  + the agent loop (the runAgentLoop kernel, now library-owned)     │
  └────────────────────────────────────────────────────────────────────┘
```

The library does not know about Anthropic, MCP, or NDJSON. The library knows about `ModelProvider`, `ToolRegistry`, and `CapabilityTraceSink`. The three adapters translate.

## Structure pass

Three layers carry this boundary: the **client** layer (the thin agent wrappers in `lib/agents/`), the **adapter** layer (the three classes in `aptkit-adapters.ts`), the **library** layer (`@aptkit/core`'s agents). One axis worth tracing: **who owns the loop?**

```
  Axis: who owns the agent loop?

  ┌─ pre-AptKit (lib/agents/base-legacy.ts:86-176) ──┐
  │  THIS REPO owns runAgentLoop                      │   270 LOC hand-rolled
  │  hand-rolled turn loop + tool_use plumbing        │   preserved as a receipt
  └───────────────────────────────────────────────────┘

  seam ═══════════════════════════════════════════════════════
       │  AptKit lifted the loop into a library
       ▼
  ┌─ post-AptKit (lib/agents/*.ts wrappers) ──────────┐
  │  LIBRARY owns the loop                             │   library code, library tests
  │  THIS REPO owns three adapters at the boundary     │   3 classes, 206 LOC
  │  + thin wrappers over each library agent           │
  └───────────────────────────────────────────────────┘
```

The axis flips at the seam: before the migration this repo owned both the loop and the boundary; after, the library owns the loop and the boundary becomes a single file. That's why the legacy implementation is preserved at `lib/agents/base-legacy.ts` (and `*-legacy.ts` for each agent) — as a rollback receipt, and as a witness for what was lifted.

## How it works

### Move 1 — the mental model

You've used React's `useState` over multiple frameworks. The `useState` *contract* is the same — call it with an initial value, get a tuple of state and setter, the framework re-renders. The *implementation* differs (React's fiber reconciler vs. Preact's diff vs. Solid's signals). The component code is the same; the runtime underneath is the seam.

The AptKit boundary is the same shape. The "agent loop" is the runtime. The "Blooming agent code" is the component code. The three adapters are how Blooming's specific runtime — Anthropic SDK, MCP via `DataSource`, NDJSON route hooks — plugs into the library's generic contracts.

```
  The pattern: library expects ports; this repo provides adapters

  ┌─ @aptkit/core ─────────────────────────┐
  │  AnomalyMonitoringAgent({               │
  │    model: ModelProvider,        ◄────── │  port 1
  │    tools: ToolRegistry,         ◄────── │  port 2
  │    trace: CapabilityTraceSink,  ◄────── │  port 3
  │    workspace, categories                │
  │  })                                      │
  │                                          │
  │  agent.scan() runs the loop:             │
  │    while (more turns):                   │
  │      model.complete(...)                 │
  │      for each tool_use block:            │
  │        tools.callTool(...)              │
  │        trace.emit(events)               │
  └─────────────────────────────────────────┘

  this repo provides:
    ┌─────────────────────────────────────┐
    │ AnthropicModelProviderAdapter        │  → wraps `@anthropic-ai/sdk`
    │ BloomingToolRegistryAdapter          │  → wraps DataSource (the other port)
    │ BloomingTraceSinkAdapter             │  → wraps NDJSON event hooks
    └─────────────────────────────────────┘
```

Three ports → three adapters. The library never imports `@anthropic-ai/sdk`; this repo never re-implements the agent loop.

### Move 2 — the step-by-step walkthrough

#### adapter 1 — `AnthropicModelProviderAdapter`

The library's `ModelProvider` port has one method: `complete(request) → response`, with library-defined `ModelRequest` and `ModelResponse` types. The adapter's job is to translate those types into Anthropic SDK calls and translate the SDK's response back.

```ts
// lib/agents/aptkit-adapters.ts:26-72
export class AnthropicModelProviderAdapter implements ModelProvider {
  readonly id = 'anthropic';
  readonly defaultModel: string;
  private readonly logSite: string;

  constructor(
    private readonly anthropic: Anthropic,
    agent: AgentName,
    private readonly sessionId?: string,
    model = AGENT_MODEL,                              // claude-sonnet-4-6 by default
    logSite = `agents/${agent}:aptkit-model`,
  ) { this.defaultModel = model; this.logSite = logSite; }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: this.defaultModel,
      max_tokens: request.maxTokens ?? 4096,
      messages: request.messages.map(toAnthropicMessage),
    };
    if (request.system) params.system = request.system;
    if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);

    const response = await this.anthropic.messages.create(
      params,
      request.signal ? { signal: request.signal } : undefined,    // cancel-aware
    );

    console.log(JSON.stringify({                                  // res.usage logged
      site: this.logSite, sessionId: this.sessionId, usage: response.usage,
    }));

    return {
      content: response.content.flatMap(toModelContentBlock),
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      model: response.model,
    };
  }
}
```

Three load-bearing details inside this single method:

- **`request.signal` threaded into the SDK call** (`aptkit-adapters.ts:52-55`). The library's `ModelRequest` carries the cancel signal; the adapter forwards it to the SDK as `{ signal }`. Without this, the route's `req.signal` would die at the library boundary and the SDK call would keep burning the 300s budget.
- **`res.usage` logged per call** (`aptkit-adapters.ts:57-61`, also `:65`). Token usage is the observability spine for cost tracking — one log line per LLM call, structured for filtering.
- **Two translation helpers** (`toAnthropicMessage` at `:144`, `toAnthropicContentBlock` at `:155`, `toAnthropicTool` at `:179`, `toModelContentBlock` at `:187`). The library's content-block types are generic (`text`, `tool_use`, `tool_result`); the Anthropic SDK's types are concrete. The translators are pure functions and small — three of them total under 60 LOC.

```
  Pattern — the model adapter as a bidirectional translator

  ┌─ library ─────────────────┐                 ┌─ Anthropic SDK ─────────┐
  │  ModelRequest             │ ──translate──► │  MessageCreateParams    │
  │  { messages, tools, … }   │                 │  { messages, tools, … } │
  └──────────────┬────────────┘                 └────────────┬────────────┘
                 │                                            │
                 │  awaits a response                         │
                 ▼                                            ▼
  ┌─ library ─────────────────┐                 ┌─ Anthropic SDK ─────────┐
  │  ModelResponse            │ ◄──translate── │  response                │
  │  { content, usage, model }│                 │  { content, usage, ... }│
  └───────────────────────────┘                 └─────────────────────────┘
```

#### adapter 2 — `BloomingToolRegistryAdapter`

The library's `ToolRegistry` port has two methods: `listTools()` returns the available tool definitions; `callTool(name, args, options)` executes one. This is the layer that bridges to the *other* port in this repo — the `DataSource`. So this adapter is a tiny one: it forwards.

```ts
// lib/agents/aptkit-adapters.ts:75-97
export class BloomingToolRegistryAdapter implements ToolRegistry {
  constructor(
    private readonly dataSource: McpCaller,            // ← Pick<DataSource, 'callTool'>
    private readonly allTools: McpToolDef[],
  ) {}

  listTools(): ToolDefinition[] {
    return this.allTools.map((tool) => ({              // shape-translate
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
    return { result, durationMs };                      // drop `fromCache` — library doesn't need it
  }
}
```

This is the load-bearing composition. Two ports meet here: the library's `ToolRegistry` (the *consumer side* of this adapter) and the repo's `DataSource` (the *dependency side*). The agents in this repo never call `dataSource.callTool` directly during a scan — the library does, via this adapter. The adapter is what makes the chain work: route → factory → `DataSource` → `BloomingToolRegistryAdapter` → library agent.

Note `McpCaller = Pick<DataSource, 'callTool'>` (`lib/agents/base.ts:14`). The adapter narrows the port further: it doesn't need `listTools` (the route already called it). Interface segregation in action — adapters whose `listTools` is expensive could still serve.

```
  Layers-and-hops — tool call routing through both adapters

  ┌─ @aptkit/core agent ──┐  hop 1: tools.callTool('execute_analytics_eql', {...}, {signal})
  │  decides what to call │ ───────────────────────────────────────────────────────────►
  └───────────────────────┘                                                              ┌─ BloomingToolRegistryAdapter ──┐
                                                                                         │  this.dataSource.callTool(...)  │
                                                                                         └────────────┬────────────────────┘
                                                                                                      │
                                                                                                      │ hop 2: callTool
                                                                                                      ▼
                                                                                         ┌─ DataSource (port) ─────────────┐
                                                                                         │  resolved to BloomreachDataSource│
                                                                                         │  OR SyntheticDataSource          │
                                                                                         └────────────┬────────────────────┘
                                                                                                      │
                                                                                                      │ hop 3: HTTPS or fixture
                                                                                                      ▼
                                                                                                  external/in-process
                                                                                                  result
                                                                                         ┌────────────▼────────────────────┐
                                                                                         │  { result, durationMs, fromCache}│
                                                                                         └────────────┬────────────────────┘
                                                                                                      │ hop 4: drop fromCache
  ┌──────────────────────────◄────────────────────────────────────────────────────────────────────────┘
  │  { result, durationMs }
  ▼
  library wraps in tool_result block, hands back to model
```

Two adapter classes, two ports, one chain. The library asks for "callTool"; the answer travels through both abstractions before it touches network.

#### adapter 3 — `BloomingTraceSinkAdapter`

The library's `CapabilityTraceSink` port has one method: `emit(event)`. Whenever the library does something noteworthy — model decided to call a tool, tool started, tool finished, model emitted text — it emits an event through this port. The adapter routes those events to this repo's existing hook surface, which the route layer turns into NDJSON.

```ts
// lib/agents/aptkit-adapters.ts:100-141
export class BloomingTraceSinkAdapter implements CapabilityTraceSink {
  private readonly activeToolCalls = new Map<string, ToolCall[]>();

  constructor(
    private readonly hooks: AptKitAgentHooks,         // onToolCall, onToolResult, onText
    private readonly agent: AgentName,
  ) {}

  emit(event: CapabilityEvent): void {
    if (event.type === 'step') {                       // model emitted text
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
      const toolCall = this.activeToolCalls.get(event.toolName)?.shift() ?? this.toBloomingToolCall(event);
      toolCall.durationMs = event.durationMs;
      toolCall.result = event.result;
      toolCall.error = event.error;
      this.hooks.onToolResult?.(toolCall);
    }
  }
  …
}
```

The `activeToolCalls` queue is the load-bearing piece. The library emits `tool_call_start` and `tool_call_end` separately, with no shared id between them — just the tool name. If the same tool is called twice in parallel (which AptKit's monitoring agent does within the rate-limit envelope), the adapter has to match starts with ends in order. The `Map<toolName, ToolCall[]>` plus shift-on-end handles that ordering.

```
  Execution trace — two parallel calls of the same tool

  state:     activeToolCalls = { }
  emit:      tool_call_start { toolName: 'execute_analytics_eql' }
  state:     activeToolCalls = { execute_analytics_eql: [TC#1] }
  hooks:     onToolCall(TC#1)

  emit:      tool_call_start { toolName: 'execute_analytics_eql' }   (parallel)
  state:     activeToolCalls = { execute_analytics_eql: [TC#1, TC#2] }
  hooks:     onToolCall(TC#2)

  emit:      tool_call_end { toolName: 'execute_analytics_eql', durationMs: 1200, result }
  shift:     activeToolCalls = { execute_analytics_eql: [TC#2] }
  hooks:     onToolResult(TC#1 with result + duration)

  emit:      tool_call_end { toolName: 'execute_analytics_eql', durationMs: 1450, result }
  shift:     activeToolCalls = { execute_analytics_eql: [] }
  hooks:     onToolResult(TC#2 with result + duration)
```

The downstream effect: the route's `onToolResult` callback fires twice in the right order, emitting two `tool_call_end` NDJSON events with the right durations. The UI's trace panel renders both correctly.

#### the thin wrappers — five active agents

Each agent in `lib/agents/` is now a constructor + a single method that builds the three adapters and calls the library agent. The receipt is `MonitoringAgent` (the largest of the five at ~50 LOC):

```ts
// lib/agents/monitoring.ts:73-94
export class MonitoringAgent {
  constructor(
    private anthropic: Anthropic,
    private dataSource: McpCaller,
    private schema: WorkspaceSchema,
    private allTools: McpToolDef[],
    private sessionId?: string,
  ) {}

  async scan(hooks?: MonitorHooks, categories: AnomalyCategory[] = []): Promise<Anomaly[]> {
    const toolRegistry = new BloomingToolRegistryAdapter(this.dataSource, this.allTools);
    const agent = new AptKitAnomalyMonitoringAgent({
      model: new AnthropicModelProviderAdapter(this.anthropic, 'monitoring', this.sessionId),
      tools: toolRegistry,
      workspace: this.schema,
      trace: new BloomingTraceSinkAdapter(hooks ?? {}, 'monitoring'),
      categories: categories.length ? toAptKitCategories(categories, this.schema.projectId) : [],
    });
    return (await agent.scan({ signal: hooks?.signal })).map(toBloomingAnomaly);
  }
}
```

The whole wrapper is: build the three adapters, hand them to the library, await the result, translate the library's anomaly type to this repo's `Anomaly` type. The legacy version of this same agent at `lib/agents/monitoring-legacy.ts` does all of the loop logic itself; the post-AptKit version is what this seam unlocks.

#### the legacy rollback receipt

The hand-rolled loop is preserved at `lib/agents/base-legacy.ts:86-176`:

```ts
// lib/agents/base-legacy.ts:86-176 (excerpt)
export async function runAgentLoop<T = null>(
  opts: RunAgentLoopOpts<T>,
): Promise<AgentRunResult<T>> {
  …
  for (let turn = 0; turn < maxTurns; turn++) {
    signal?.throwIfAborted();
    const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
    const forceFinal = turn === maxTurns - 1 || budgetSpent;
    const params = { model: AGENT_MODEL, max_tokens, system: …, messages };
    if (!forceFinal) params.tools = toolSchemas;
    const res = await anthropic.messages.create(params, signal ? { signal } : undefined);
    …
    // Append assistant turn; extract text + tool_use; execute tools via dataSource.callTool;
    // append tool_result blocks; loop.
  }
}
```

The library's loop does the same job. The legacy file's purpose is twofold: it's a rollback path if the library breaks unrecoverably at 0.x, and it's the witness for what *was* lifted (the file is the diff between "in-tree loop" and "library loop"). Every active agent has a `*-legacy.ts` sibling for the same reason.

```
  Comparison — pre and post AptKit, side by side

  ┌─ pre-AptKit ────────────────────┐    ┌─ post-AptKit ────────────────────┐
  │ this repo: runAgentLoop (270 LOC)│    │ library: AnomalyMonitoringAgent  │
  │ this repo: MonitoringAgent       │    │ this repo: MonitoringAgent       │
  │   (calls runAgentLoop directly)  │    │   (~50 LOC wrapper)              │
  │ NO adapter classes               │    │ 3 adapter classes (206 LOC total)│
  │ NO library dependency            │    │ @aptkit/core@0.3.0 on the loop   │
  │                                  │    │                                   │
  │ ╳ loop logic in this repo's tests│    │ ✓ loop tested by the library     │
  │ ╳ no other consumers of the loop │    │ ✓ library could be reused        │
  │ ✓ no library risk                │    │ ╳ library risk at pre-1.0        │
  └──────────────────────────────────┘    │ ⤺ legacy kept as rollback receipt│
                                          └──────────────────────────────────┘
```

### Move 3 — the principle

Library boundaries are *also* ports + adapters. When code in your repo calls a library, the library is the dependency and your code is the consumer — same shape as DataSource. When a library calls *into* your code (via callbacks, interfaces, or strategy objects it accepts), the library is the consumer and your code is the adapter. AptKit is the second shape: it accepts `ModelProvider`, `ToolRegistry`, `CapabilityTraceSink` ports, and this repo provides the adapters.

The transferable lesson: when a library exposes ports for the runtime-specific bits (the model client, the storage, the event sink), you can adopt the library without coupling to it deeply. The blast radius of a library upgrade is the adapter file — 206 LOC here. The blast radius of a library downgrade (the legacy rollback) is also that file, plus deleting `*-legacy.ts`. That's the test: a clean library boundary has a known, small blast radius in both directions.

## Primary diagram

```
  aptkit-primitive-boundary — full picture

  ┌─ Service layer (this repo) ───────────────────────────────────────────────┐
  │                                                                            │
  │  routes (briefing, agent)                                                  │
  │      │                                                                     │
  │      │  constructs                                                         │
  │      ▼                                                                     │
  │  thin agent wrappers (lib/agents/*.ts)                                     │
  │      │                                                                     │
  │      │  builds                                                             │
  │      ▼                                                                     │
  │  ┌─────────────────────────────────────────────────────────────────────┐   │
  │  │ AnthropicModelProviderAdapter implements ModelProvider              │   │
  │  │   ├─ wraps Anthropic SDK client                                     │   │
  │  │   ├─ translates ModelRequest ↔ MessageCreateParams                  │   │
  │  │   ├─ threads request.signal into the SDK                            │   │
  │  │   └─ logs { site, sessionId, usage } per call                       │   │
  │  ├─────────────────────────────────────────────────────────────────────┤   │
  │  │ BloomingToolRegistryAdapter implements ToolRegistry                  │   │
  │  │   ├─ holds McpCaller = Pick<DataSource, 'callTool'>                  │   │
  │  │   ├─ listTools() → shape-translates McpToolDef[]                     │   │
  │  │   └─ callTool() → dataSource.callTool() → drop fromCache             │   │
  │  ├─────────────────────────────────────────────────────────────────────┤   │
  │  │ BloomingTraceSinkAdapter implements CapabilityTraceSink              │   │
  │  │   ├─ holds AptKitAgentHooks { onToolCall, onToolResult, onText }     │   │
  │  │   ├─ activeToolCalls Map<toolName, ToolCall[]> matches start/end     │   │
  │  │   └─ routes step / tool_call_start / tool_call_end to hooks          │   │
  │  └─────────────────────────────────────────────────────────────────────┘   │
  │      │                                                                     │
  │      │  hands all three into                                                │
  │      ▼                                                                     │
  └──────┼─────────────────────────────────────────────────────────────────────┘
         │
  ┌──────▼─────────── @aptkit/core@0.3.0 ─────────────────────────────────────┐
  │  AnomalyMonitoringAgent / DiagnosticAgent / RecommendationAgent / QueryAgent│
  │                                                                            │
  │  agent.scan({ signal }) runs the loop:                                     │
  │    while (turn < maxTurns):                                                │
  │      res = model.complete({ messages, tools, signal })                     │
  │      trace.emit({ type: 'step', content: text })                           │
  │      for each tool_use block:                                              │
  │        trace.emit({ type: 'tool_call_start', toolName, args })             │
  │        result = tools.callTool(name, args, { signal })                     │
  │        trace.emit({ type: 'tool_call_end', toolName, durationMs, result }) │
  │      if no more tool_use → break (synthesis turn)                          │
  │                                                                            │
  │  returns: typed result (MonitoringAnomaly[], Diagnosis, …)                 │
  └─────────────────────────────────────────────────────────────────────────────┘

  legacy preserved at lib/agents/base-legacy.ts:86-176 + agents/*-legacy.ts
    as rollback receipt + witness for what was lifted
```

## Elaborate

**Why three ports and not one.** AptKit could have exposed a single `AgentEnvironment` port with all three concerns merged. Splitting them into three is the right call: each one has a different rotation. The model swap (Anthropic → OpenAI → some local model) only touches `ModelProvider`. The data source swap (Bloomreach → Synthetic → SQL adapter) only touches `ToolRegistry`. The trace transport swap (NDJSON → SSE → just-console) only touches `CapabilityTraceSink`. Three small ports buy three independent rotation axes; one big port would couple them.

**The cost of a pre-1.0 library on the critical path.** `@aptkit/core@0.3.0` is the receipt: a pre-1.0 library *on the critical path* is a calculated bet. The hedge is what's in this repo today: (a) all integration confined to one 206-LOC adapter file, (b) every agent has a `*-legacy.ts` sibling preserving the pre-AptKit hand-roll, (c) the integration tests run against this repo's behavior, not against the library's API. If 0.4 breaks the adapter contract, the diff is one file; if 0.4 breaks correctness without breaking the adapter, the rollback is `git revert + delete *-legacy.ts → restore`. The bet is the right one when the library's loop is high-quality work that this repo would otherwise have to maintain forever.

**The dual-pass `activeToolCalls` map.** The library doesn't share an id between `tool_call_start` and `tool_call_end` — only the tool name. The naive implementation would store one `ToolCall` per tool name, but then two parallel calls of the same tool would clobber. The adapter uses `Map<toolName, ToolCall[]>` — push on start, shift on end — which is FIFO per tool name. The result is correct ordering as long as the library emits ends in the same order as starts (which it does for the common parallel case). A future library version that wants strict id-based pairing would change the port, and this adapter would simplify to `Map<id, ToolCall>`.

**Comparison to the DataSource seam.** Same shape, opposite direction:

- DataSource seam — *this repo defines the port*; the library doesn't see it.
- AptKit boundary — *the library defines the ports*; this repo provides the adapters.

Both are dependency inversion. In both, the inner ring (the abstraction owner) doesn't depend on the outer ring (the implementation). DataSource: the agents are the inner ring; the Bloomreach SDK is the outer. AptKit: the library is the inner ring; this repo is the outer. The pattern is symmetric — when you have a port, both sides of it are decoupled.

## Interview defense

**Q: Why three adapter classes? Why not just put the library calls inline in each agent?**

> Because the library's three ports rotate independently and the adapters are the only place that touches the library. `AnthropicModelProviderAdapter` knows about the Anthropic SDK; the library doesn't. `BloomingToolRegistryAdapter` knows about the `DataSource` port; the library doesn't. `BloomingTraceSinkAdapter` knows about the NDJSON hooks; the library doesn't. If the library's `ModelProvider` interface changes in 0.4, the diff is the model adapter — not five agent files. Inline calls would couple every agent to all three library ports at once; the adapters concentrate that coupling in 206 LOC, which is the blast radius for a library upgrade.

```
  the rotation axes

  ┌─ model swap ──────────┐  touches: AnthropicModelProviderAdapter only
  ┌─ data source swap ────┐  touches: BloomingToolRegistryAdapter only
  ┌─ trace transport swap ┐  touches: BloomingTraceSinkAdapter only

  inline-in-agent: every swap touches every agent
  3-adapter:       every swap touches one adapter
```

**Anchor:** `lib/agents/aptkit-adapters.ts:26, 75, 100`.

**Q: What part of `BloomingTraceSinkAdapter` would someone forget to write — the "if it broke, what would you notice last" piece?**

> The `activeToolCalls` Map and the shift-on-end. The library emits `tool_call_start` and `tool_call_end` separately with no shared id — just the tool name. If two scans of the same EQL fire in parallel within the rate-limit envelope, the adapter needs to pair start #1 with end #1 and start #2 with end #2 in order. A naive `Map<toolName, ToolCall>` would clobber the first call when the second starts; you'd see one duration on the wire instead of two, and the UI's trace panel would render the first call as "still running." The `Map<toolName, ToolCall[]>` with push-on-start, shift-on-end gives FIFO per tool name. If the library ever adds a shared id, the adapter simplifies to `Map<id, ToolCall>` and this kernel goes away.

```
  the load-bearing kernel

  Map<toolName, ToolCall[]>
    push on tool_call_start
    shift on tool_call_end  ← without this, parallel calls clobber

  what's hardening (not the kernel):
    toBloomingToolCall translator
    the type guards (isRecord)
```

**Anchor:** `lib/agents/aptkit-adapters.ts:101, 116-128`.

**Q: There are `*-legacy.ts` files for every agent. Why are they still in the tree?**

> Two reasons. First, rollback. `@aptkit/core` is at `0.3.0` — a pre-1.0 library on the critical path. If a future version breaks the loop and we can't get a fix landed quickly, the rollback is `git revert the migration PR + restore *-legacy.ts → import paths`. The legacy file at `lib/agents/base-legacy.ts:86-176` is the hand-rolled `runAgentLoop` that ran the production loop before AptKit; it's still tested. Second, the legacy files are the *witness* — they document what was lifted into the library. When someone asks "what does AptKit actually do," the answer is "the diff between `base-legacy.ts` and the library agent." Both reasons go away when the library hits 1.0 and the migration is six months old without a regression; until then the rollback receipt has real option value.

```
  the rollback receipt

  ┌─ lib/agents/base-legacy.ts ─┐  the hand-rolled loop (preserved)
  ┌─ lib/agents/monitoring-legacy.ts ─┐  pre-AptKit MonitoringAgent
  ┌─ … (every agent has a sibling) ─┐

  rollback path:
    git revert <migration PR>
    + import-path restore from legacy/
    + delete lib/agents/aptkit-adapters.ts
    + uninstall @aptkit/core
```

**Anchor:** `lib/agents/base-legacy.ts:86-176`.

## See also

- `01-request-flow.md` — where the adapters get constructed (phase 3 of the briefing flow)
- `03-datasource-seam.md` — the port the tool registry adapter forwards to
- `06-streaming-ndjson.md` — where the trace sink's events land on the wire

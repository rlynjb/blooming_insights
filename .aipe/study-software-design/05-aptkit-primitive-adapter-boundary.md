# AptKit primitive adapters — adapter boundary as a deep-module pattern

**Industry name(s):** Adapter pattern · port and adapter (hexagonal) · primitive interface + domain implementation · information hiding at the dependency seam (Ousterhout)
**Type:** Industry standard · Language-agnostic (the second instance of this pattern in the repo — the first is the `DataSource` seam, this one is at the agent ↔ library boundary)

> **POST-2026-06-19 ADDITION.** This concept file is new in the 2026-06-19 refresh. Phase 3 PR brought `@aptkit/core@0.3.0` into the repo as a reusable agent library: an `AnomalyMonitoringAgent`, a `DiagnosticInvestigationAgent`, a `RecommendationAgent`, and a `QueryAgent`, each parameterized over three small primitive interfaces — `ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`. Blooming owns three 60–80-LOC adapter classes in `lib/agents/aptkit-adapters.ts` (`AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter`) that implement those primitives in Blooming's domain (Anthropic SDK, `DataSource`-backed tool calls, NDJSON streaming hooks). The four production agent classes (`monitoring.ts`, `diagnostic.ts`, `recommendation.ts`, `query.ts`) each shrank to ~30–50 LOC of compatibility shim — they instantiate the AptKit agent with three Blooming adapters and return. This is the same APOSD lesson as `01-mcp-client-deep-module.md`, repeated at a different scale: small interface, fat hidden body, secret lives in one place.

> The repeat matters. **The pattern teaches twice in this codebase** — once at the `DataSource` seam (one interface, two adapter implementations, factory hides selection) and once at the AptKit primitive seam (three interfaces, one adapter implementation per interface, agent classes hide the wiring). Same shape, different scale. Reading both files in order is how the lesson lands.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** AptKit is a separate npm package (`@aptkit/core` published as `@rlynjb/aptkit-core@0.3.0`). It does not know what an Anthropic SDK is, what a Bloomreach MCP server is, or what NDJSON looks like. It knows three primitive interfaces: a thing that completes model requests, a thing that lists and calls tools, a thing that absorbs trace events. Blooming owns three small adapter classes that bridge AptKit's primitive shapes to Blooming's concrete dependencies. The boundary sits at `lib/agents/aptkit-adapters.ts`; everything above it (the four agent classes, the route handlers) plays in Blooming's universe; everything below it (AptKit's agent loops) plays in AptKit's universe.

```
Zoom out — where the adapter boundary sits

┌─ Route handler band ──────────────────────────────────────────────┐
│  /api/briefing  /api/agent                                         │
└──────────────────────────┬────────────────────────────────────────┘
                           │ instantiate Blooming agent class
┌─ Blooming agent class band ──▼─────────────────────────────────────┐
│  MonitoringAgent · DiagnosticAgent · RecommendationAgent · QueryAgent│
│    (30–50 LOC each, holds Anthropic+DataSource+schema+hooks)         │
└──────────────────────────┬────────────────────────────────────────┘
                           │ new BloomingXxxAdapter(...)
┌─ ★ Adapter boundary ─★──▼─────────────────────────────────────────┐
│  lib/agents/aptkit-adapters.ts  (206 LOC, 3 small classes)         │  ← we are here
│    AnthropicModelProviderAdapter   implements ModelProvider          │
│    BloomingToolRegistryAdapter     implements ToolRegistry           │
│    BloomingTraceSinkAdapter        implements CapabilityTraceSink    │
└──────────────────────────┬────────────────────────────────────────┘
                           │ AptKit agent reads only the primitive surfaces
┌─ AptKit reusable agent band ──▼───────────────────────────────────┐
│  @aptkit/core@0.3.0                                                 │
│    AnomalyMonitoringAgent · DiagnosticInvestigationAgent ·          │
│    RecommendationAgent · QueryAgent                                 │
│    (knows nothing about Anthropic, Bloomreach, NDJSON, or this app) │
└────────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The pattern is the **adapter** — one small class per generic interface, each absorbing the impedance between AptKit's primitive shape and Blooming's concrete dependency. The depth ratio sits at each adapter individually: `AnthropicModelProviderAdapter` exposes one method (`complete(request)`), its body absorbs the Anthropic SDK's message-shape translation, the `tool_use` ↔ `tool_result` block coercion, the usage-token logging convention, and the abort-signal threading. AptKit reads `complete(request)`; it does not know Anthropic exists.

---

## Structure pass

**Layers.** Three for this concept: **AptKit's primitive interface layer** (what `@aptkit/core` reads), **Blooming's adapter layer** (the three classes that implement those interfaces in Blooming's terms), and **Blooming's domain dependencies** (Anthropic SDK, `DataSource`, NDJSON hook callbacks).

**Axis: knowledge ownership.** For each fact about the implementation (the Anthropic message-shape grammar, the `tool_use`/`tool_result` block coercion, the `DataSource` envelope, the NDJSON hook shapes, the `ToolCall` Blooming-domain type), which side owns it? Trace this one axis up the stack and the answer flips exactly once — at the adapter boundary. Above it (AptKit): the answer is "I don't know any of these things." Below it (Blooming's adapter body): "I own all of them." That flip is the load-bearing seam.

**Seams.** Three primitive interfaces, three seams, all flipping the same axis the same way:

- `ModelProvider.complete(request)` — above: AptKit sends a `ModelRequest` (system, messages, tools, maxTokens, signal); below: the adapter translates to Anthropic's `MessageCreateParams` and back.
- `ToolRegistry.listTools()` + `ToolRegistry.callTool(name, args, opts?)` — above: AptKit reads typed `ToolDefinition[]` and calls tools by name; below: the adapter maps to Blooming's `McpToolDef` array and the `DataSource.callTool` envelope.
- `CapabilityTraceSink.emit(event)` — above: AptKit emits `CapabilityEvent`s (step / tool_call_start / tool_call_end); below: the adapter translates each event back into Blooming's existing NDJSON hook shape (`onText`, `onToolCall`, `onToolResult`) so the route handlers don't change.

```
Structure pass — the adapter boundary

┌─ 1. LAYERS ──────────────────────────────────────────────────────┐
│  AptKit primitive interface · Blooming adapter · Blooming domain  │
└─────────────────────────────┬────────────────────────────────────┘
                              │  pick the axis
┌─ 2. AXIS ──────────────────▼──────────────────────────────────────┐
│  knowledge ownership: who knows the Anthropic SDK, the DataSource │
│  envelope, the NDJSON hook shape, the Blooming ToolCall type?     │
└─────────────────────────────┬────────────────────────────────────┘
                              │  trace across the seams
┌─ 3. SEAMS ─────────────────▼──────────────────────────────────────┐
│  ModelProvider          ToolRegistry        CapabilityTraceSink   │
│  control flips:  AptKit picks WHEN to call; adapter picks HOW     │
│  state flips:    AptKit holds nothing; adapter holds activeTools  │
│                  map for the start↔end pairing                    │
│  failure flips:  Anthropic SDK throws caught at adapter boundary  │
└─────────────────────────────┬────────────────────────────────────┘
                              ▼
                      Block 4 — How it works
```

---

## How it works

### Move 1 — the mental model (the adapter ratio)

You know how a power adapter for a foreign-country wall socket has the foreign prongs on one side and your country's prongs on the other? The body absorbs the voltage and prong-shape translation; the laptop on your side never has to learn that the wall delivers 220V or that the prongs are a different shape. Same pattern here, applied to library dependencies. Each adapter has the AptKit shape on one side (`ModelProvider.complete`, `ToolRegistry.callTool`, `CapabilityTraceSink.emit`) and the Blooming domain on the other (`Anthropic.messages.create`, `dataSource.callTool`, `hooks.onText/onToolCall/onToolResult`).

```
The adapter ratio — picture

  ┌─ AptKit reads ──────────────────────────────────────────────┐
  │  modelProvider.complete(request)                              │
  │  → ModelResponse { content[], usage, model }                  │
  └─────────────────────────────┬─────────────────────────────────┘
                                │  the adapter absorbs:
                                ▼
  ┌─ AnthropicModelProviderAdapter body ────────────────────────┐
  │  1. translate ModelMessage[] → Anthropic.MessageParam[]      │
  │  2. translate ModelTool[]    → Anthropic.Tool[]              │
  │  3. translate ModelContentBlock ↔ Anthropic content blocks   │
  │  4. translate ModelToolResultBlock → Anthropic tool_result    │
  │  5. forward signal to Anthropic options                       │
  │  6. emit usage-token log line in Blooming's format            │
  │  7. translate Anthropic.ContentBlock → ModelContentBlock[]    │
  └─────────────────────────────────────────────────────────────┘

  ratio: 1 primitive method exposed, 7 mechanics absorbed.
  same shape repeats for ToolRegistry and CapabilityTraceSink.
```

### Move 2 — the kernel, one adapter at a time

Walk the three adapters one at a time. Each is named by what breaks when it's missing.

**`AnthropicModelProviderAdapter` — the SDK translation.** Implements `ModelProvider`. Body absorbs the bidirectional translation between AptKit's generic `ModelMessage` / `ModelTool` / `ModelContentBlock` / `ModelToolResultBlock` shapes and Anthropic's concrete `MessageParam` / `Tool` / `ContentBlock` shapes. Also owns the usage-token log emit (so any LLM-cost dashboard Blooming runs on the `agents/<name>:aptkit-model` log site keeps working unchanged). Drop the adapter: AptKit would have to take a hard dependency on the Anthropic SDK, and switching providers later means rewriting AptKit's loops instead of swapping the adapter.

**`BloomingToolRegistryAdapter` — the DataSource translation.** Implements `ToolRegistry`. Body absorbs the mapping from Blooming's `McpToolDef[]` to AptKit's `ToolDefinition[]` (a structural rename: `name`, `description`, `inputSchema`), and translates the `DataSource.callTool` return envelope (`{ result, durationMs, fromCache }`) to AptKit's `{ result, durationMs }` shape. Drop the adapter: AptKit would have to either (a) take a hard dependency on Blooming's `DataSource` type, or (b) consume an MCP transport directly — coupling the library to either side defeats the point of having primitives.

**`BloomingTraceSinkAdapter` — the event translation.** Implements `CapabilityTraceSink`. Body absorbs the translation from AptKit's `CapabilityEvent` discriminated union (`step` / `tool_call_start` / `tool_call_end`) back into Blooming's pre-existing NDJSON hook shape (`onText` / `onToolCall` / `onToolResult`). Owns a small `activeToolCalls: Map<toolName, ToolCall[]>` queue so the `tool_call_end` event can find the matching `ToolCall` (the AptKit event carries only the tool name, not the original `ToolCall` object). Drop the adapter: the route handlers' NDJSON producers would change shape, every UI consumer would have to change with them, and the `AgentEvent` contract that the project pinned in "What must not change" would shift. The adapter is the load-bearing piece that lets the AptKit migration happen without the wire format moving.

```
Pattern — three primitive adapters, three independent kernels

  Blooming agent class (e.g. MonitoringAgent)
       │
       │  constructs all three adapters per call,
       │  passes them to the AptKit agent constructor
       ▼
  ┌── three primitives, three adapters ──────────────────────────┐
  │                                                                │
  │   ModelProvider          ToolRegistry         CapabilityTraceSink│
  │   ────────────           ────────────         ──────────────────│
  │   Anthropic SDK    ←     DataSource    ←      onText / onToolCall│
  │     translation              translation         pairing logic    │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘
       │
       ▼
  AptKit agent (knows none of: Anthropic, DataSource, NDJSON, ToolCall)
```

### Move 2 variant — the skeleton parts

```
The kernel as load-bearing parts

  THE PRIMITIVE INTERFACES (AptKit owns)        what AptKit reads
  ────────────────────────────────────────────────────────────────
  ModelProvider                                  complete(request)
  ToolRegistry                                   listTools() / callTool(...)
  CapabilityTraceSink                            emit(event)

  THE ADAPTER CLASSES (Blooming owns)            what's absorbed below
  ────────────────────────────────────────────────────────────────
  AnthropicModelProviderAdapter (45 LOC)         Anthropic SDK shape,
                                                  usage logging
  BloomingToolRegistryAdapter (22 LOC)           DataSource envelope,
                                                  tool-def renaming
  BloomingTraceSinkAdapter (43 LOC)              CapabilityEvent →
                                                  hook callbacks,
                                                  start↔end pairing

  THE WIRING (Blooming agent classes)            what nobody sees
  ────────────────────────────────────────────────────────────────
  MonitoringAgent.scan        instantiate AptKit agent + 3 adapters
  DiagnosticAgent.investigate                       (same)
  RecommendationAgent.propose                        (same)
  QueryAgent.answer                                   (same)
```

Each adapter is small (22–45 LOC). Each is the only file in Blooming that knows ONE specific translation. Drop any single adapter and exactly one library boundary breaks; the other two keep working.

### Move 2 — code in this codebase

**Use cases.** Every agent-driven path runs through these adapters. Concrete scenarios:

- `MonitoringAgent.scan` in `lib/agents/monitoring.ts:81-95` is invoked by `/api/briefing`. It constructs all three adapters per call and passes them to the AptKit `AnomalyMonitoringAgent` constructor. Anthropic SDK calls happen inside AptKit's loop, but they go through `AnthropicModelProviderAdapter.complete`. Tool calls go through `BloomingToolRegistryAdapter.callTool`. The reasoning trace lines that the UI renders in `StatusLog` come from `BloomingTraceSinkAdapter.emit` firing the host's `onText`/`onToolCall`/`onToolResult` hooks.
- `DiagnosticAgent.investigate` (`lib/agents/diagnostic.ts:35-44`) — same pattern, AptKit's `DiagnosticInvestigationAgent` underneath. The route handler in `/api/agent` doesn't know AptKit is involved; it sees a Blooming class with a familiar method signature.
- A future swap of AptKit (e.g. `@aptkit/core@0.4.0` with breaking changes to one primitive) would touch one adapter class. Blooming's agent classes, route handlers, UI, NDJSON contract: all unchanged. That's the property the adapter boundary buys.

**The model provider adapter — bidirectional SDK translation.** Seven mechanics absorbed behind a single `complete(request)` method.

```
lib/agents/aptkit-adapters.ts  (lines 26–72)

  export class AnthropicModelProviderAdapter implements ModelProvider {
    readonly id = 'anthropic';                                          ← AptKit reads
    readonly defaultModel: string;
    private readonly logSite: string;

    constructor(
      private readonly anthropic: Anthropic,                             ← Blooming dependency
      agent: AgentName,
      private readonly sessionId?: string,
      model = AGENT_MODEL,
      logSite = `agents/${agent}:aptkit-model`,                          ← Blooming log convention
    ) {
      this.defaultModel = model;
      this.logSite = logSite;
    }

    async complete(request: ModelRequest): Promise<ModelResponse> {       ← the one method
      const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
        model: this.defaultModel,
        max_tokens: request.maxTokens ?? 4096,
        messages: request.messages.map(toAnthropicMessage),                ← TRANSLATE 1
      };

      if (request.system) params.system = request.system;
      if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool); ← TRANSLATE 2

      const response = await this.anthropic.messages.create(
        params,
        request.signal ? { signal: request.signal } : undefined,           ← forward signal
      );

      console.log(JSON.stringify({                                         ← Blooming log shape
        site: this.logSite,
        sessionId: this.sessionId,
        usage: response.usage,
      }));

      return {                                                              ← TRANSLATE 3
        content: response.content.flatMap(toModelContentBlock),
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        model: response.model,
      };
    }
  }
       │
       └─ AptKit calls complete(request) and gets back a ModelResponse.
          it never imports @anthropic-ai/sdk; it has no idea the SDK exists.
          if Blooming swaps providers (OpenAI? Vertex?), exactly this class
          changes. that's the depth ratio paying for itself.
```

**The tool-registry adapter — the DataSource bridge.** Twenty-two lines, two methods, and the entire DataSource protocol hides behind it from AptKit's perspective.

```
lib/agents/aptkit-adapters.ts  (lines 75–97)

  export class BloomingToolRegistryAdapter implements ToolRegistry {
    constructor(
      private readonly dataSource: McpCaller,                              ← Blooming dependency
      private readonly allTools: McpToolDef[],
    ) {}

    listTools(): ToolDefinition[] {
      return this.allTools.map((tool) => ({                                ← rename only
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
      return { result, durationMs };                                       ← envelope narrowed
    }
  }
       │
       └─ AptKit knows nothing about `fromCache` — the BloomingToolRegistryAdapter
          drops that field on the way through. (The cache-hit telemetry still flows
          via the BloomingTraceSinkAdapter; AptKit's primitive doesn't need it.)
          the entire DataSource seam from 01-mcp-client-deep-module.md is hidden
          behind this 22-LOC adapter from AptKit's perspective.
```

**The trace-sink adapter — event translation with start↔end pairing.** The one place any adapter holds state. The `activeToolCalls` queue is the load-bearing piece that keeps the NDJSON contract unchanged across the migration.

```
lib/agents/aptkit-adapters.ts  (lines 100–142)

  export class BloomingTraceSinkAdapter implements CapabilityTraceSink {
    private readonly activeToolCalls = new Map<string, ToolCall[]>();      ← pairing state

    constructor(
      private readonly hooks: AptKitAgentHooks,                            ← Blooming hooks
      private readonly agent: AgentName,
    ) {}

    emit(event: CapabilityEvent): void {                                   ← the one method
      if (event.type === 'step') {
        this.hooks.onText?.(event.content);                                ← direct passthrough
        return;
      }

      if (event.type === 'tool_call_start') {
        const toolCall = this.toBloomingToolCall(event);                   ← TRANSLATE 1
        const existing = this.activeToolCalls.get(event.toolName) ?? [];
        existing.push(toolCall);                                            ← queue for pairing
        this.activeToolCalls.set(event.toolName, existing);
        this.hooks.onToolCall?.(toolCall);
        return;
      }

      if (event.type === 'tool_call_end') {
        const toolCall = this.activeToolCalls.get(event.toolName)?.shift()  ← dequeue match
          ?? this.toBloomingToolCall(event);
        toolCall.durationMs = event.durationMs;
        toolCall.result = event.result;
        toolCall.error = event.error;
        this.hooks.onToolResult?.(toolCall);
      }
    }
    ...
  }
       │
       └─ the `activeToolCalls` map is the only piece of state any adapter holds.
          it exists because AptKit's start/end events are independent (no shared id),
          but Blooming's `onToolResult` hook expects the *same* ToolCall object
          shape as `onToolCall` fired. drop the queue: `onToolResult` gets a fresh
          ToolCall with no `args`, the UI's ToolCallBlock loses the input JSON, the
          investigation trace becomes harder to read. small queue, load-bearing.
```

**The wiring — Blooming agent classes shrunk to instantiation.** Each agent class collapsed to ~14 LOC of construct-and-forward; the loop body that used to live here moved into `@aptkit/core`.

```
lib/agents/monitoring.ts  (lines 81–95)

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
       │
       └─ MonitoringAgent.scan shrank from a 122-LOC orchestration function to a
          14-LOC instantiate-and-forward. The four agent classes (monitoring,
          diagnostic, recommendation, query) all have the same shape now —
          construct three adapters, pass to AptKit, forward the result.
          the loop body that used to live here moved into @aptkit/core entirely.
```

### Move 3 — the principle

The adapter is the discipline that lets a reusable library stay generic. AptKit ships with three primitive interfaces because it doesn't want to know which model provider, which tool transport, or which trace consumer the host application uses. Blooming ships three small adapter classes because Blooming doesn't want to leak Anthropic/DataSource/NDJSON details into a generic agent library. **Each side hides its specifics behind a small interface; the adapter is the file that absorbs the impedance.** That's the trade: one small class per boundary, in exchange for a library that can be reused unchanged in another app and an app that can swap libraries without rewriting every agent class.

This is the same lesson as `01-mcp-client-deep-module.md` — interface size vs absorbed behavior — applied at the dependency boundary instead of the protocol boundary. Reading both files in order shows the principle scaling: one adapter per backend at the DataSource seam, one adapter per primitive at the AptKit seam.

---

## Primary diagram

The full picture — three primitives, three adapters, three independent translations, one boundary.

```
AptKit primitive adapters — the deep-module recap

   Blooming agent class                ┌─ lib/agents/aptkit-adapters.ts ────────┐
   ┌──────────────────────┐             │                                          │
   │ MonitoringAgent      │  per call   │  AnthropicModelProviderAdapter           │
   │ DiagnosticAgent      │ ──────────► │    complete(request)                     │
   │ RecommendationAgent  │             │      a. ModelMessage → Anthropic shape   │
   │ QueryAgent           │             │      b. ModelTool    → Anthropic.Tool    │
   └──────────────────────┘             │      c. signal       → SDK option        │
                                        │      d. anthropic.messages.create        │
                                        │      e. log usage at agents/<name>:…     │
                                        │      f. content[]    → ModelContentBlock │
                                        │                                          │
                                        │  BloomingToolRegistryAdapter             │
                                        │    listTools()                            │
                                        │      a. McpToolDef[]  → ToolDefinition[]  │
                                        │    callTool(name, args, opts?)            │
                                        │      a. forward to dataSource.callTool    │
                                        │      b. {result, durationMs} envelope     │
                                        │                                          │
                                        │  BloomingTraceSinkAdapter                │
                                        │    emit(event)                            │
                                        │      step       → hooks.onText            │
                                        │      tool_start → hooks.onToolCall +      │
                                        │                   queue ToolCall          │
                                        │      tool_end   → dequeue + hooks.onToolResult │
                                        └──────────────────────────────────────────┘
                                                       │
                                                       ▼
                                               @aptkit/core@0.3.0 agent loop
                                               (knows NONE of: Anthropic,
                                                DataSource, NDJSON, ToolCall)

   3 adapter classes.  ~110 LOC of translation.  3 cleanly separated kernels.
   the library stays generic; the app keeps its wire format.
```

---

## Elaborate

Where the pattern comes from: the **adapter pattern** has its formal Gang of Four name and an older, deeper APOSD framing — *information hiding at the dependency boundary*. AptKit's primitive interfaces are the small, hidden boundary; the three adapter classes are the absorbing bodies that mean Blooming's agent classes never see AptKit's mechanics and AptKit's agent classes never see Blooming's dependencies. The same trade as a `DataSource` seam, the same trade as the `McpClient` wrapper — but applied at a different altitude (library boundary instead of protocol boundary).

Adjacent concepts:
- **`DataSource` seam (`01-mcp-client-deep-module.md`)** — the *first* instance of this pattern in this codebase, at the MCP-protocol altitude. One interface, two adapter implementations (Bloomreach, Synthetic), factory hides selection. This file is the *second* instance, at the library-boundary altitude. **Same lesson, twice. Reading both is how the principle generalizes.**
- **Pull complexity downward** — every adapter pulls translation complexity downward from the agent class into the adapter body. The Blooming agent class doesn't translate; it constructs. The AptKit agent loop doesn't translate; it consumes primitives. The adapter is the file that pulled it down.
- **Errors as a contract** — the adapters don't add masking; they pass exceptions through. AptKit's loop catches tool-call errors and feeds them back as error tool_result blocks (the same pattern the legacy `runAgentLoop` used). The adapter doesn't get involved.

A subtle judgment call worth naming: the adapter classes could in principle be functions instead of classes (each one has one method plus state in some cases). The decision to keep them as classes matches AptKit's interface shape — `ModelProvider`, `ToolRegistry`, `CapabilityTraceSink` are nominal interfaces; instantiating with `new` keeps the call site idiomatic. The `BloomingTraceSinkAdapter` actually holds state (`activeToolCalls`), which would be awkward to do without a class. The other two are classes for consistency. That's the right call — three classes with one shape are easier to skim than two functions + one class.

What to read next: `01-mcp-client-deep-module.md` for the parallel deep-module case study at the protocol layer. The two together are the canonical "small interface, fat hidden body" pattern instantiated twice at different scales.

## Interview defense

**Q: Why is `lib/agents/aptkit-adapters.ts` three small classes instead of one combined adapter?**
A: Because the three AptKit primitives are independent — `ModelProvider` knows nothing about tools, `ToolRegistry` knows nothing about traces, `CapabilityTraceSink` knows nothing about the model. Combining them into one class would couple three independent translations behind a single constructor. Each adapter has one job: bridge ONE primitive interface to ONE Blooming dependency. Drop any single adapter and exactly one library boundary breaks; the other two keep working. That's also why a future swap of just the model provider (e.g. Anthropic → OpenAI) touches exactly one file. Three small adapter classes is the correct decomposition because three primitive interfaces is the correct decomposition.

**Q: Walk me through what would break if `BloomingTraceSinkAdapter` didn't hold the `activeToolCalls` queue.**
A: AptKit emits `tool_call_start` and `tool_call_end` as independent events — they don't share a stable id. Blooming's `onToolResult` hook, though, is fired with the *same* `ToolCall` object that `onToolCall` originally received, because the UI's `ToolCallBlock` displays the input args, the output result, and the duration as one card. Drop the queue: `onToolResult` would be called with a freshly-minted `ToolCall` that has no `args` (the `tool_call_end` event carries only the tool name + result + durationMs), so the UI card would lose its input JSON. Every investigation trace would become harder to read because the tool inputs would vanish on completion. Small queue, load-bearing. That's the part most people don't see because it's 4 lines of `Map.set` and `Map.shift` — but it's the load-bearing piece that lets the NDJSON contract stay unchanged across the AptKit migration.

```
Interview-defense diagram — why the queue is load-bearing

  WITHOUT activeToolCalls queue              WITH activeToolCalls queue
  ┌─ tool_call_start ──────┐                  ┌─ tool_call_start ──────┐
  │ name: 'execute_eql'    │ → fires onToolCall│ name: 'execute_eql'    │ → onToolCall + push
  │ args: { query: '…' }   │   with full args  │ args: { query: '…' }   │   into queue
  └────────────────────────┘                   └────────────────────────┘
  ┌─ tool_call_end ────────┐                  ┌─ tool_call_end ────────┐
  │ name: 'execute_eql'    │ → fires onToolResult│ name: 'execute_eql'    │ → shift queue,
  │ durationMs, result     │   with NEW ToolCall│ durationMs, result     │   reuse ToolCall
  │ (no args field)        │   → args missing! │ (no args field)        │   → args preserved
  └────────────────────────┘                   └────────────────────────┘
       BAD: UI ToolCallBlock loses inputs       GOOD: same ToolCall start→end,
            on every tool result                       UI renders complete card
```

## See also

- `01-mcp-client-deep-module.md` — the parallel case study at the protocol boundary. The `DataSource` seam is the same adapter-pattern lesson at a different altitude.
- `audit.md → deep-vs-shallow-modules` — names this file as the second "small interface, fat hidden body" case study in the codebase.
- `audit.md → information-hiding-and-leakage` — names the adapter boundary as the third strong hide added since 2026-06-02 (alongside the `parseRetryAfterMs` grammar and the `makeDataSource` factory).

---

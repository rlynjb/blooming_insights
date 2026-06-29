# Information hiding — the adapter bridge (AptKit)

*industry name: Adapter pattern + information hiding · type: Language-agnostic (Gang of Four × APOSD)*

---

## Zoom out, then zoom in

**Zoom out — where this pattern lives.** Between the agent layer and the AptKit primitives library.

```
  Zoom out — where the bridge (AptKit) sits in the system

  ┌─ UI layer ────────────────────────────────────────────────┐
  │  app/page.tsx + hooks                                     │
  └───────────────────────────┬───────────────────────────────┘
                              │
  ┌─ Route layer ─────────────▼───────────────────────────────┐
  │  /api/briefing · /api/agent                               │
  └───────────────────────────┬───────────────────────────────┘
                              │  new MonitoringAgent(...)
  ┌─ Agent layer ─────────────▼───────────────────────────────┐
  │  MonitoringAgent · DiagnosticAgent ·                      │
  │  RecommendationAgent · QueryAgent                         │
  │  (4 thin wrappers ~30 LOC each)                           │
  └───────────────────────────┬───────────────────────────────┘
                              │  Blooming types: Anthropic SDK,
                              │  DataSource, ToolCall, AgentName
  ┌─ Bridge layer ── ★ HERE ★ ─────────────────────────────────┐
  │  lib/agents/aptkit-adapters.ts                            │  ← you are here
  │   • AnthropicModelProviderAdapter   (Anthropic → AptKit)  │
  │   • BloomingToolRegistryAdapter     (DataSource → AptKit) │
  │   • BloomingTraceSinkAdapter        (ToolCall ← AptKit)   │
  └───────────────────────────┬───────────────────────────────┘
                              │  AptKit types: ModelProvider,
                              │  ToolRegistry, CapabilityTraceSink,
                              │  ModelMessage/Request/Response,
                              │  CapabilityEvent
  ┌─ AptKit core (npm) ───────▼───────────────────────────────┐
  │  @aptkit/core — generic agent loop primitives             │
  │  AnomalyMonitoringAgent · DiagnosticInvestigationAgent ·  │
  │  RecommendationAgent · QueryAgent  (the reusable bodies)  │
  └───────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** AptKit owns the reusable agent-loop body (tool-use loop, parse + recovery, synthesis instructions, intent classification). Blooming owns the live integrations (Anthropic SDK calls, Bloomreach `DataSource`, the route-side streaming trace). They speak different vocabularies: AptKit doesn't know what an `Anthropic.Messages.ContentBlock` is; Blooming doesn't want to hand its `DataSource` shape to a generic library. The bridge — three small adapter classes — is the seam where the two vocabularies meet. **Information hiding here means: AptKit never learns Blooming's types; Blooming's routes never learn AptKit's types. The bridge layer absorbs the translation.**

This is the *same* lesson as the DataSource seam (`01-deep-module-data-source.md`), one layer up. When the same primitive shows up at two altitudes, name it once and point at both — collapsing the two into "small interface, fat body" is the strongest version of the move.

---

## Structure pass

**Layers.** Three again:

```
  caller layer       4 Blooming agent classes
                     ──────────────────────────
                     each ~30 LOC: instantiate adapters, call the
                     matching AptKit agent, map the result back

  bridge layer       3 adapter classes in aptkit-adapters.ts
                     ────────────────────────────────────────
                     each ~70 LOC of body; small public surface
                     (the interface AptKit demands)

  consumed library   @aptkit/core
                     ──────────────
                     generic primitive interfaces; doesn't know
                     about Anthropic, MCP, or Bloomreach
```

**Axis — trace one question.** *Who decides the wire format on each side?*

```
  layer              who decides wire format?
  ─────────────      ──────────────────────────────────────────
  caller layer       Blooming decides — Anthropic SDK types,
                     DataSource envelope, ToolCall shape
  bridge layer       BOTH speak through the bridge — translation
                     is the whole point; the answer FLIPS here
  AptKit core        AptKit decides — ModelMessage, ContentBlock,
                     ModelToolResultBlock, CapabilityEvent
```

The flip happens *inside* the bridge layer, not at one of its edges — each adapter class is itself a tiny seam where Blooming's vocabulary becomes AptKit's. That's why three classes, not one: model translation, tool translation, and trace translation each have their own grammar, and mashing them together would make a 200-LOC class that's hard to read for any one purpose.

**Seams.** Two horizontal seams (caller-to-bridge, bridge-to-AptKit) AND three vertical seams (the three adapter classes are siblings handling three orthogonal concerns: model, tools, trace). The vertical separation is the readability win — each adapter is one screen, one concern.

---

## How it works

### Move 1 — the mental model

A bridge adapter is like a translator at a meeting between two delegations who don't share a language. The translator's job is to take what one side says, re-encode it in the other side's grammar, and pass it across. Neither delegation needs to learn the other's language. Both keep their own vocabulary, and the translator absorbs the work.

In code: AptKit defines `ModelProvider` ("here's a way to talk to ANY LLM"). Blooming has the Anthropic SDK. The adapter is the translator that takes AptKit's `ModelRequest` and turns it into `Anthropic.Messages.MessageCreateParamsNonStreaming`, runs the call, and turns the response back into AptKit's `ModelResponse`.

```
  The bridge adapter — three translators, one boundary

  ┌──────────────────────┐                     ┌──────────────────────┐
  │  Blooming side       │                     │   AptKit core        │
  │                      │                     │                      │
  │  Anthropic SDK ──────┼──► AnthropicModel   │                      │
  │                      │     ProviderAdapter ├──► ModelProvider     │
  │                      │                     │                      │
  │  DataSource ─────────┼──► BloomingTool     │                      │
  │  (callTool)          │     RegistryAdapter ├──► ToolRegistry      │
  │                      │                     │                      │
  │  ToolCall ◄──────────┼──── BloomingTrace   │                      │
  │  (route hooks)       │     SinkAdapter     ├──◄ CapabilityTraceSink
  │                      │                     │                      │
  └──────────────────────┘                     └──────────────────────┘
   knows: Anthropic,                            knows: ModelProvider,
   DataSource, ToolCall                         ToolRegistry,
                                                CapabilityTraceSink
                                                (its OWN interfaces)

   neither side ever imports the other's types;
   the bridge is the only file that imports BOTH
```

The benefit is bidirectional. AptKit can ship a new agent (say a forecasting agent) and Blooming wires it by re-using the same three adapters with a different AptKit class. Blooming can swap Anthropic for Bedrock by writing ONE new `BedrockModelProviderAdapter` — the other two adapters and all four agent classes are untouched.

### Move 2 — the step-by-step walkthrough

#### Move 2a — adapter 1: model provider

`AnthropicModelProviderAdapter` (`lib/agents/aptkit-adapters.ts:26-72`, ~46 LOC). Implements AptKit's `ModelProvider`. The job: take a `ModelRequest`, produce a `ModelResponse`.

```ts
  // lib/agents/aptkit-adapters.ts:42-71 (annotated)
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: this.defaultModel,
      max_tokens: request.maxTokens ?? 4096,
      messages: request.messages.map(toAnthropicMessage),       // ← translate down
    };
    if (request.system) params.system = request.system;
    if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);

    const response = await this.anthropic.messages.create(
      params,
      request.signal ? { signal: request.signal } : undefined,  // ← cancellation
    );

    console.log(JSON.stringify({                                // ← observability
      site: this.logSite,
      sessionId: this.sessionId,
      usage: response.usage,
    }));

    return {
      content: response.content.flatMap(toModelContentBlock),   // ← translate up
      usage: {
        inputTokens: response.usage.input_tokens,               // ← snake → camel
        outputTokens: response.usage.output_tokens,
      },
      model: response.model,
    };
  }
```

**What's load-bearing:**

  - **`toAnthropicMessage` / `toAnthropicTool` / `toAnthropicContentBlock`** (`:144-185`) — the down-translators. Pure functions, no state. The bridge file is the ONLY place these conversions exist.
  - **`toModelContentBlock`** (`:187-202`) — the up-translator. Notice it `flatMap`s and returns `[]` for unknown block types: AptKit cares about `text` and `tool_use` blocks; Blooming silently drops anything else (e.g. future `thinking` blocks). That dropping decision is a hide — AptKit doesn't have to grow a case for every new Anthropic block type.
  - **`snake_case → camelCase` on `usage`** — Anthropic returns `input_tokens`; AptKit consumes `inputTokens`. The adapter owns the casing convention; neither side has to know about the other's choice.
  - **`logSite` + `sessionId`** — Blooming's observability per request. AptKit doesn't know what a sessionId is; the adapter constructor takes it and logs it.

#### Move 2b — adapter 2: tool registry

`BloomingToolRegistryAdapter` (`lib/agents/aptkit-adapters.ts:75-97`, ~22 LOC). Implements AptKit's `ToolRegistry`. The job: list tools (for the prompt), call a tool (when the model asks).

```ts
  // lib/agents/aptkit-adapters.ts:75-97 (annotated)
  export class BloomingToolRegistryAdapter implements ToolRegistry {
    constructor(
      private readonly dataSource: McpCaller,                  // ← Blooming type
      private readonly allTools: McpToolDef[],                 // ← Blooming type
    ) {}

    listTools(): ToolDefinition[] {                            // ← AptKit type
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
    ): Promise<{ result: unknown; durationMs: number }> {      // ← AptKit envelope
      const { result, durationMs } = await this.dataSource.callTool(name, args, options);
      return { result, durationMs };                           // ← drop fromCache
    }
  }
```

**What's load-bearing:**

  - **`McpCaller = Pick<DataSource, 'callTool'>`** (defined in `lib/agents/base.ts:14`). The adapter takes the narrowest possible view of `DataSource` — it doesn't need `listTools()`. APOSD again: take only what you need; if you grow, the type errors will tell you. Compose two narrow interfaces (`DataSource` and AptKit's `ToolRegistry`) without leaking either.
  - **Dropping `fromCache`** in the return — AptKit's `ToolRegistry.callTool` envelope is `{ result, durationMs }`. `fromCache` is a Blooming-side trace concern. The adapter is the boundary where it gets dropped on the way in, and where the corresponding `tool_call_end` event reconstitutes the route-side trace separately.

#### Move 2c — adapter 3: trace sink (the trickiest)

`BloomingTraceSinkAdapter` (`lib/agents/aptkit-adapters.ts:100-142`, ~42 LOC). Implements AptKit's `CapabilityTraceSink`. The job: turn AptKit's `CapabilityEvent` stream into Blooming's `ToolCall` objects so the route handlers can NDJSON-encode them for the UI.

This is the trickiest adapter because AptKit emits `tool_call_start` and `tool_call_end` as separate events with the same `toolName + timestamp`, and Blooming's `ToolCall` is *one* object with both. The adapter has to stitch them back together.

```ts
  // lib/agents/aptkit-adapters.ts:100-142 (annotated)
  export class BloomingTraceSinkAdapter implements CapabilityTraceSink {
    private readonly activeToolCalls = new Map<string, ToolCall[]>();
    //                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //                                Internal stitching buffer.
    //                                Per toolName, a queue of in-flight
    //                                calls awaiting their _end event.

    emit(event: CapabilityEvent): void {
      if (event.type === 'step') {
        this.hooks.onText?.(event.content);          // ← reasoning text → route
        return;
      }

      if (event.type === 'tool_call_start') {
        const toolCall = this.toBloomingToolCall(event);
        const existing = this.activeToolCalls.get(event.toolName) ?? [];
        existing.push(toolCall);                     // ← buffer the start
        this.activeToolCalls.set(event.toolName, existing);
        this.hooks.onToolCall?.(toolCall);           // ← emit to route NOW
        return;
      }

      if (event.type === 'tool_call_end') {
        const toolCall =
          this.activeToolCalls.get(event.toolName)?.shift()  // ← FIFO match
          ?? this.toBloomingToolCall(event);                 // ← orphan safety
        toolCall.durationMs = event.durationMs;
        toolCall.result = event.result;
        toolCall.error = event.error;
        this.hooks.onToolResult?.(toolCall);         // ← emit completed call
      }
    }
  }
```

**What's load-bearing:**

  - **The `Map<toolName, ToolCall[]>` buffer.** APOSD lesson: the adapter holds the stitching state internally; the route never sees it. AptKit thinks in events; Blooming thinks in completed `ToolCall` objects; the adapter absorbs the impedance mismatch.
  - **FIFO `shift()` on the queue** — if the model fires `execute_analytics_eql` twice in parallel, the first `_end` event matches the first `_start` event. Without the queue, parallel calls would scramble.
  - **The orphan fallback** (`?? this.toBloomingToolCall(event)`) — if an `_end` arrives with no matching `_start` (an AptKit invariant violation), the adapter still emits a usable `ToolCall` rather than crashing.
  - **Event-to-ToolCall mapping** (`toBloomingToolCall`, `:132-141`) — the only place this conversion exists. Adds the agent-name tag (`monitoring` / `diagnostic` / etc.) so the UI can color-code who fired which tool.

### Move 2 variant — the load-bearing skeleton

The kernel: **three adapter classes**, **each implementing one AptKit interface**, **each translating in and out of Blooming types**.

What breaks when each part is missing:

  - **Drop the model adapter** — agent classes have to instantiate AptKit + Anthropic SDK directly; AptKit grows an Anthropic dependency or stays without LLM support; the seam erodes.
  - **Drop the tool adapter** — AptKit has to know about Blooming's `DataSource`; the cross-coupling kills AptKit's reusability.
  - **Drop the trace adapter** — AptKit's event stream surfaces directly to the route; the route now has to know AptKit's event vocabulary; every change to AptKit's events fans out to every route.

The three adapters are co-equal. Unlike a true kernel pattern (where one part is the irreducible core), this is three sibling translators — what makes it work is *exactly three orthogonal concerns, each in its own class*. Fold any two together and you've made a worse module.

### Move 3 — the principle

> **Information hiding is bidirectional.** A module that hides its caller's types from its dependencies — not just its internals from its callers — is what makes a library reusable. AptKit doesn't know what Anthropic is; Blooming doesn't know what `CapabilityEvent` is. The adapter pays the translation cost so neither side has to.
>
> When the same primitive (small interface, fat body) appears at two altitudes — the DataSource seam below, the AptKit bridge here — that's a *self-similar design*. Name it once; recognize the second occurrence as the same shape; you've collapsed two concepts into one.

---

## Primary diagram

```
  The AptKit bridge — three translators, one boundary, two vocabularies

  ┌─ caller: Blooming agent classes ───────────────────────────────────┐
  │  MonitoringAgent     DiagnosticAgent     RecommendationAgent       │
  │  QueryAgent          (each ~30 LOC; thin wrappers)                 │
  └──────────────────────────────┬─────────────────────────────────────┘
                                 │ instantiate
  ┌─ lib/agents/aptkit-adapters.ts (206 LOC, 3 classes) ───────────────┐
  │                                                                    │
  │   AnthropicModelProviderAdapter      ── implements ──► ModelProvider│
  │     constructor(anthropic, agent,                                  │
  │                 sessionId?, model?,                                │
  │                 logSite?)                                          │
  │     complete(ModelRequest)                                         │
  │       → toAnthropicMessage(msg) ×N                                 │
  │       → anthropic.messages.create(params, { signal })              │
  │       → toModelContentBlock(block) ×N                              │
  │       → ModelResponse                                              │
  │                                                                    │
  │   BloomingToolRegistryAdapter        ── implements ──► ToolRegistry │
  │     constructor(dataSource, allTools)                              │
  │     listTools()                                                    │
  │       → allTools.map(...)  → ToolDefinition[]                      │
  │     callTool(name, args, opts?)                                    │
  │       → dataSource.callTool(name, args, opts?)                     │
  │       → { result, durationMs }                                     │
  │                                                                    │
  │   BloomingTraceSinkAdapter      ── implements ──► CapabilityTraceSink│
  │     constructor(hooks, agent)                                      │
  │     activeToolCalls: Map<toolName, ToolCall[]>  ← internal buffer  │
  │     emit(CapabilityEvent)                                          │
  │       → 'step'             → hooks.onText                          │
  │       → 'tool_call_start'  → buffer + hooks.onToolCall             │
  │       → 'tool_call_end'    → shift + enrich + hooks.onToolResult   │
  │                                                                    │
  └──────────────────────────────┬─────────────────────────────────────┘
                                 │ consumed by
  ┌─ @aptkit/core ─────────────────▼─────────────────────────────────────┐
  │  ModelProvider · ToolRegistry · CapabilityTraceSink                │
  │  (the primitive interfaces the agents are written against)         │
  │  AnomalyMonitoringAgent · DiagnosticInvestigationAgent ·           │
  │  RecommendationAgent · QueryAgent  (reusable bodies)               │
  └────────────────────────────────────────────────────────────────────┘

  the bridge is the ONLY file that imports BOTH vocabularies
  → @anthropic-ai/sdk (Blooming side)
  → @aptkit/core      (consumed library side)
```

---

## Elaborate

**Where this primitive comes from.** Gang of Four's Adapter pattern (1994) named the shape. Parnas's information-hiding (1972) named the rule. APOSD ties them together: an adapter that hides its caller's vocabulary from its dependency is doing information hiding bidirectionally. The book's example is a database VFS that hides SQL dialect from the application AND hides the application schema from the SQL engine.

**What changed in this codebase.** Before the AptKit migration, Blooming had its own `runAgentLoop` in `lib/agents/base.ts` (270 LOC, now preserved at `base-legacy.ts`). Each agent class implemented its own one-turn recovery synthesis. AptKit lifted that loop into a generic library; the three adapter classes are how Blooming kept its own types while consuming the lifted body. The four agent classes shrank to ~30 LOC each. **The lift only worked because the translation seam was small enough to fit in one file.**

**What's adjacent in this codebase.**

  - `01-deep-module-data-source.md` — the same primitive (small interface, fat body) at a different scale.
  - `audit.md` Lens 4 (layers-and-abstractions) — the bridge is one of the layers where the contract genuinely transforms; not a pass-through.

**What to read next.** `.aipe/read-aposd/part-2/04-information-hiding.md` for the hiding rule in full; the GoF Adapter pattern for the structural shape.

---

## Interview defense

**Q1: Where does information hiding show up in this codebase?**

Most visibly in `lib/agents/aptkit-adapters.ts` — 206 LOC, three small adapter classes that bridge AptKit's generic primitive interfaces to Blooming's owned types. Each adapter is ~30–70 LOC and implements exactly one AptKit interface. The bridge is the ONLY file in the codebase that imports both `@aptkit/core` and `@anthropic-ai/sdk`. AptKit doesn't know what Anthropic is; the four Blooming agent classes don't know what a `CapabilityEvent` is. Both sides keep their own vocabulary.

```
  ┌─ Blooming ─┐    bridge    ┌─ AptKit core ─┐
  │  Anthropic ├──── 3 ────────┤  ModelProv    │
  │  DataSource│   adapters    │  ToolRegistry │
  │  ToolCall  │   ~70 LOC ea  │  TraceSink    │
  └────────────┘               └───────────────┘
```

Anchor: `lib/agents/aptkit-adapters.ts`.

**Q2: Why three adapter classes, not one?**

Because the three concerns are orthogonal. Model translation is about message shape and SDK call. Tool translation is about envelope shape and a `DataSource` forward. Trace translation is about an event-stream-to-object-stitch with internal buffering. Mash them together and you get a 200-LOC class where the trace-stitching state is sitting next to message conversion — no one screen tells you what's going on. Three classes, three single-purpose files, each one screen. Readability is the win.

The trace adapter is the trickiest — it holds a `Map<toolName, ToolCall[]>` internally to stitch AptKit's `tool_call_start` + `tool_call_end` pair back into one Blooming `ToolCall`. The state belongs in that adapter; spreading it would break the seam.

```
  Map<toolName, ToolCall[]>
       │
       ▼ on _start:  push(toolCall)
       ▼ on _end:    shift()  → enrich → emit completed
       ▼ orphan _end: fall back to a fresh ToolCall (safety net)
```

Anchor: `lib/agents/aptkit-adapters.ts:100-142`.

**Q3: What's the load-bearing detail people miss about this kind of bridge?**

The translation is bidirectional, but the import asymmetry isn't. The bridge imports from BOTH vocabularies; neither vocabulary imports the bridge. That's what keeps AptKit reusable (it ships to npm without an Anthropic peer dep) AND keeps Blooming's agents from learning AptKit's wire format. If anyone on either side were to import the other's types, the seam erodes. The bridge file's import list is the rule that has to hold.

Anchor: top of `lib/agents/aptkit-adapters.ts` (imports both `@anthropic-ai/sdk` and `@aptkit/core`); nothing else in the repo imports both.

**Q4: Same APOSD lesson as the DataSource seam — how do you describe the relationship?**

It's the same primitive — small interface, fat body — at a different altitude. The DataSource seam is one interface (73 LOC, two methods) over two bodies totaling ~730 LOC. The AptKit bridge is three interfaces (AptKit's `ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`) over three corresponding adapter classes (~200 LOC total of body). When the same primitive appears twice in one codebase, that's a self-similar design — it's a signal that "small interface, fat body" is the load-bearing design move here, and it's worth getting right at both altitudes.

```
  altitude 1 — data:     DataSource (73 LOC) → 730 LOC body
  altitude 2 — agents:   AptKit primitives  → 206 LOC bridge
                                              + 30 LOC per agent class
  same shape; different scale
```

Anchor: cross-reference `01-deep-module-data-source.md`.

---

## See also

  → `01-deep-module-data-source.md` — same lesson at the data layer.
  → `03-pulled-complexity-down-readndjson.md` — pull-complexity-down at the streaming layer.
  → `audit.md` Lens 2 (deep-vs-shallow-modules), Lens 3 (information-hiding-and-leakage), Lens 4 (layers-and-abstractions).
  → `.aipe/read-aposd/part-2/04-information-hiding.md` — the book chapter on hiding.
  → `.aipe/read-aposd/part-2/05-general-purpose.md` — on writing for "somewhat-general-purpose."

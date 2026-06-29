# 03 — the AptKit bridge (information hiding at the seam)

## Subtitle

Adapter (Gang of Four) · anti-corruption layer · information hiding — *Industry standard (DDD strategic patterns)*.

## Zoom out — where the bridge lives

There are two vocabularies in this codebase. Blooming's domain types (`ToolCall`, `ReasoningStep`, `AgentEvent`, `Anomaly`, `Diagnosis`, `Recommendation`) and Anthropic's SDK types (`Anthropic.Messages.MessageParam`, `ContentBlockParam`). Plus a third: `@aptkit/core`'s provider-neutral types (`ModelProvider`, `ModelMessage`, `ToolRegistry`, `CapabilityEvent`). The bridge sits in one file and stops these three vocabularies from leaking into each other.

```
  Zoom out — the bridge between Blooming and @aptkit/core

  ┌─ Blooming's vocabulary ─────────────────────────────────────────┐
  │  ToolCall · ReasoningStep · AgentEvent · Anomaly · Diagnosis    │
  │  + Anthropic SDK types (MessageParam, ContentBlockParam, ...)   │
  └────────────────────────────┬────────────────────────────────────┘
                               │  bridged at one file
  ┌─ The bridge (★ THIS CONCEPT ★) ─────────▼──────────────────────┐
  │  lib/agents/aptkit-adapters.ts (206 LOC)                       │ ← we are here
  │    3 adapter classes + 4 helper functions                       │
  │    AnthropicModelProviderAdapter                                │
  │    BloomingToolRegistryAdapter                                  │
  │    BloomingTraceSinkAdapter                                     │
  └────────────────────────────┬────────────────────────────────────┘
                               │  AptKit's contract
  ┌─ @aptkit/core's vocabulary ─────────────▼──────────────────────┐
  │  ModelProvider · ModelMessage · ModelTool · ToolRegistry        │
  │  CapabilityEvent · CapabilityTraceSink · ToolDefinition         │
  └─────────────────────────────────────────────────────────────────┘
```

## Zoom in — what it is

When two systems each have their own typed vocabulary, and you want them to talk without either learning the other's words, the move is a **bridge** of adapters: one class per role on the AptKit side, each one accepting Blooming's types and emitting AptKit's (or vice versa). The agents in `lib/agents/` stay in Blooming's vocabulary; `@aptkit/core` stays in its own. They meet at this one file, and only at this one file.

This is information hiding at its sharpest — **the decision "we use AptKit version 0.3.0" is contained inside one file**. Swap to 0.4.0, only this file changes. The same idea has two industry names:

  → the **Adapter pattern** (Gang of Four, 1994) — wrap an existing interface so it conforms to the expected one,
  → the **anti-corruption layer** (Eric Evans, *Domain-Driven Design*, 2003) — keep one bounded context's vocabulary from polluting another.

The role-vocabulary for this pattern:

```
  adaptee        the thing on one side that already exists
                 → Blooming's Anthropic SDK client; the DataSource port;
                   Blooming's hook callbacks
  target         the interface the other side wants to consume
                 → @aptkit/core's ModelProvider, ToolRegistry, CapabilityTraceSink
  adapter        the class that wraps the adaptee and presents the target
                 → AnthropicModelProviderAdapter, BloomingToolRegistryAdapter,
                   BloomingTraceSinkAdapter
  seam           the wall the two vocabularies meet at — exactly this file
```

## Structure pass — layers · axes · seams

Three layers stack here: Blooming's agent layer (the *client* of AptKit), the bridge file (the *seam*), and AptKit's internals (the *provider*). Hold one axis still and watch it change.

**Axis = which vocabulary owns this object?**

```
  Trace "what vocabulary does this object speak?" across the bridge

  ┌─ Blooming agent ──────────────────────┐
  │  speaks: Blooming + Anthropic SDK     │
  │  e.g. `Anthropic.Messages.MessageParam`│
  └─────────────┬─────────────────────────┘
                │  passes Blooming object IN
                ▼
  ┌─ Bridge ──────────────────────────────┐
  │  speaks: BOTH (this is the only file  │ ← the wall
  │           in the repo that does)      │
  └─────────────┬─────────────────────────┘
                │  passes AptKit object OUT
                ▼
  ┌─ AptKit ──────────────────────────────┐
  │  speaks: ModelMessage / ModelTool /   │
  │           CapabilityEvent — its own   │
  └───────────────────────────────────────┘
```

The seam (the bridge file) is the load-bearing boundary. Above it, no Blooming file imports any `@aptkit/core` type that isn't re-exported by the bridge. Below it, no AptKit code knows the word `Anthropic.Messages.MessageParam`. **The axis flips at exactly one file.**

## How it works

### Move 1 — the mental model

A power-plug adapter when you travel: your laptop has a Type A plug; the wall has a Type C socket. The adapter has Type A on one side and Type C on the other. The laptop never grows a Type C plug; the wall never grows a Type A socket. Without the adapter, you're rewiring one or the other.

That's exactly the shape here. Blooming has its plug (`ToolCall`, `ReasoningStep`, etc.). AptKit has its socket (`CapabilityEvent`, `ToolDefinition`). The bridge is the adapter with both ends.

The literal shape:

```
  The bridge pattern — three adapters, three vocabularies, one wall

  Blooming side                         AptKit side
  (the adaptee)                          (the target)
                          ┌─ adapter 1 ─┐
  Anthropic.Messages.       ◄──────────►     ModelProvider
  MessageParam               translation     ModelMessage
  (request/response)                          ModelResponse

                          ┌─ adapter 2 ─┐
  DataSource.callTool        ◄──────────►     ToolRegistry
  (Blooming's port)          translation     ToolDefinition

                          ┌─ adapter 3 ─┐
  ToolCall (Blooming        ◄──────────►     CapabilityEvent
  hook callbacks)            translation     CapabilityTraceSink

  ↑ three classes, each maps one role across the wall ↑
```

### Move 2 — the step-by-step walkthrough

#### Part 1 — the model provider adapter (request/response translation)

`AnthropicModelProviderAdapter` (`lib/agents/aptkit-adapters.ts:26-72`) takes AptKit's vendor-neutral request shape, converts it to the Anthropic SDK's shape, calls `anthropic.messages.create()`, then converts the response *back* to AptKit's shape. Two translations in one method.

```ts
// lib/agents/aptkit-adapters.ts:42-72 (excerpt — the load-bearing method)
async complete(request: ModelRequest): Promise<ModelResponse> {
  // ── outbound translation: AptKit's ModelRequest → Anthropic's MessageCreateParams
  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: this.defaultModel,
    max_tokens: request.maxTokens ?? 4096,
    messages: request.messages.map(toAnthropicMessage),     // ← helper at line 144
  };
  if (request.system) params.system = request.system;
  if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);

  // ── the actual SDK call — the one line where Anthropic's vocabulary lives
  const response = await this.anthropic.messages.create(
    params,
    request.signal ? { signal: request.signal } : undefined,
  );

  // ── observability — structured log line shared with the route's phase log
  console.log(JSON.stringify({
    site: this.logSite,
    sessionId: this.sessionId,
    usage: response.usage,
  }));

  // ── inbound translation: Anthropic's response → AptKit's ModelResponse
  return {
    content: response.content.flatMap(toModelContentBlock),  // ← helper at line 187
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    model: response.model,
  };
}
```

The two `map`/`flatMap` helpers (`toAnthropicMessage` and `toModelContentBlock`) are tiny pure functions defined at the bottom of the file (lines 144-202). They're the actual content-block translation: AptKit's `{ type: 'text' | 'tool_use' | 'tool_result' }` ↔ Anthropic's `Anthropic.Messages.ContentBlockParam`.

**The hide:** the agent code (`MonitoringAgent`, `DiagnosticAgent`, etc.) never touches `Anthropic.Messages.MessageParam` or `Anthropic.Messages.ContentBlockParam`. It hands `@aptkit/core` a `MonitoringAgent` instance with a `model` property typed as `ModelProvider`. AptKit calls `model.complete(request)` and gets back `ModelResponse`. Nobody outside this file knows there's an Anthropic SDK in the loop.

#### Part 2 — the tool registry adapter (the port-to-port adapter)

`BloomingToolRegistryAdapter` (`lib/agents/aptkit-adapters.ts:75-97`) is the smallest adapter — it bridges Blooming's `DataSource` port to AptKit's `ToolRegistry` port. Two ports meeting at the seam.

```ts
// lib/agents/aptkit-adapters.ts:75-97
export class BloomingToolRegistryAdapter implements ToolRegistry {
  constructor(
    private readonly dataSource: McpCaller,                   // ← Blooming's port (narrow form)
    private readonly allTools: McpToolDef[],
  ) {}

  // ── AptKit asks for tool defs in its own shape; we map ours into it
  listTools(): ToolDefinition[] {
    return this.allTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  // ── AptKit asks for a tool call; we forward to Blooming's DataSource
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<{ result: unknown; durationMs: number }> {
    const { result, durationMs } = await this.dataSource.callTool(name, args, options);
    return { result, durationMs };                            // ← drop `fromCache` (not in AptKit's contract)
  }
}
```

Two methods. One drops a field (`fromCache`, which AptKit doesn't need). The other reshapes a `ToolDef` list into AptKit's `ToolDefinition[]`. **That's the whole adapter.** It's a port-to-port translator — narrow, mechanical, exactly the right depth for its job.

#### Part 3 — the trace sink adapter (the event/hook translation)

`BloomingTraceSinkAdapter` (`lib/agents/aptkit-adapters.ts:100-142`) is the most interesting — it translates AptKit's *event stream* into Blooming's *hook callbacks*. The two are different idioms: events are pushed into a sink; hooks are functions called explicitly.

```ts
// lib/agents/aptkit-adapters.ts:100-142 (the load-bearing dispatcher)
export class BloomingTraceSinkAdapter implements CapabilityTraceSink {
  private readonly activeToolCalls = new Map<string, ToolCall[]>();

  constructor(
    private readonly hooks: AptKitAgentHooks,           // ← Blooming's hook surface
    private readonly agent: AgentName,
  ) {}

  emit(event: CapabilityEvent): void {                  // ← AptKit's event idiom
    if (event.type === 'step') {
      this.hooks.onText?.(event.content);
      return;
    }

    if (event.type === 'tool_call_start') {
      const toolCall = this.toBloomingToolCall(event);  // ← AptKit → Blooming type
      const existing = this.activeToolCalls.get(event.toolName) ?? [];
      existing.push(toolCall);
      this.activeToolCalls.set(event.toolName, existing);
      this.hooks.onToolCall?.(toolCall);                // ← fire Blooming hook
      return;
    }

    if (event.type === 'tool_call_end') {
      // pair end events with their start so we mutate the SAME ToolCall the
      // route's `onToolCall` saw — letting the UI's `tool_call_end` arm
      // (useBriefingStream.ts:244-262) attach `durationMs`/`result`/`error`
      // to the same trace item without ambiguity.
      const toolCall = this.activeToolCalls.get(event.toolName)?.shift()
                       ?? this.toBloomingToolCall(event);
      toolCall.durationMs = event.durationMs;
      toolCall.result = event.result;
      toolCall.error = event.error;
      this.hooks.onToolResult?.(toolCall);
    }
  }
  // ...
}
```

The adapter does three jobs:

  1. **Type translation** — AptKit's `CapabilityEvent` becomes Blooming's `ToolCall`.
  2. **Pairing state** — the `Map<string, ToolCall[]>` matches `tool_call_end` events to their corresponding `tool_call_start` so the same object flows through both Blooming hooks. AptKit doesn't carry this pairing in its event shape; the adapter computes it.
  3. **Idiom translation** — push-based events become callback-based hooks.

That third point is the load-bearing one. Blooming's route handlers (`/api/briefing/route.ts:262-280`) hand each agent a `{ onToolCall, onToolResult, onText, signal }` hook object. The agents pass that hook object into `BloomingTraceSinkAdapter`'s constructor. AptKit drives the agent loop and emits events into the sink; the sink fan-outs those events into the hooks the route layer wired up. *Two completely different event idioms, reconciled at one wall.*

#### Part 4 — the agents themselves, after the bridge does its job

This is the payoff. With the bridge doing the translation, each agent class is tiny:

```ts
// lib/agents/diagnostic.ts:35-44 — the entire DiagnosticAgent.investigate method
async investigate(anomaly: Anomaly, hooks: AgentHooks = {}): Promise<Diagnosis> {
  const agent = new AptKitDiagnosticInvestigationAgent({
    model: new AnthropicModelProviderAdapter(this.anthropic, 'diagnostic', this.sessionId),
    tools: new BloomingToolRegistryAdapter(this.dataSource, this.allTools),
    workspace: this.schema,
    trace: new BloomingTraceSinkAdapter(hooks, 'diagnostic'),
  });

  return toBloomingDiagnosis(await agent.investigate(anomaly, { signal: hooks.signal }));
}
```

**9 lines of body.** The agent class does four things: wire up three adapters, pass the schema and the typed anomaly through, await the AptKit call, run one final type translation. The whole `DiagnosticAgent` class is 49 lines including the file-level imports. Compare to `lib/agents/diagnostic-legacy.ts` (112 LOC, twice the size) — the legacy version inlined what the bridge now hides.

That ratio is what *deep* looks like at the application layer: the agent's job (investigate an anomaly) is a tiny method body, because the adapter classes carry the translation weight. The agent stays in Blooming's vocabulary throughout.

### Move 3 — the principle

**Information hiding is about which decisions one module can change without forcing every other module to change.** The decision being hidden here is: *we use `@aptkit/core` version 0.3.0, which has these types, these constructor shapes, this event format.* That decision lives in one file. When 0.4.0 ships, only this file changes — the agent classes stay the same; the route handlers stay the same; the UI hooks stay the same.

This is the *anti-corruption layer* version of information hiding. Eric Evans' framing in *Domain-Driven Design* (2003): when your codebase has to integrate with an outside system whose vocabulary is different from your own, you don't let that outside vocabulary leak into your domain. You build a translation wall — and you put **all** of the translation on the wall, not half here and half there. A leaky anti-corruption layer is worse than none, because it gives a false sense that the seam exists.

The discipline check: **search the rest of the repo for any import of `@aptkit/core` outside `lib/agents/`.** If the only places are the agent classes themselves (which need the typed AptKit *agent classes* like `AptKitDiagnosticInvestigationAgent`), the wall is intact. If a UI hook or a route handler imports `CapabilityEvent`, the wall has a hole.

## Primary diagram

The bridge in full, both directions, with the three adapters labelled:

```
  ┌─ Blooming side ────────────────────────────────────────────────────┐
  │                                                                    │
  │  ┌─ Route handler ─────────────────────────────────────────────┐  │
  │  │  const diagAgent = new DiagnosticAgent(                     │  │
  │  │    anthropic, dataSource, schema, allTools, sid             │  │
  │  │  );                                                          │  │
  │  │  await diagAgent.investigate(anomaly, {                     │  │
  │  │    onToolCall, onToolResult, onText, signal                 │  │
  │  │  });                                                         │  │
  │  └────────────────────────────┬────────────────────────────────┘  │
  │                               │                                    │
  │  ┌─ DiagnosticAgent (49 LOC) ─▼────────────────────────────────┐  │
  │  │  new AptKitDiagnosticInvestigationAgent({                   │  │
  │  │    model: new AnthropicModelProviderAdapter(...),           │──┼──┐
  │  │    tools: new BloomingToolRegistryAdapter(...),             │──┼──┤
  │  │    trace: new BloomingTraceSinkAdapter(hooks, ...),         │──┼──┤
  │  │    workspace: schema                                        │  │  │
  │  │  });                                                         │  │  │
  │  └─────────────────────────────────────────────────────────────┘  │  │
  └─────────────────────────────────────────────────────────────────────┘  │
                                                                            │
  ┌─ THE WALL — lib/agents/aptkit-adapters.ts (206 LOC) ──────────────────▼┐
  │                                                                        │
  │   ┌─ Adapter 1 ────────────────────────┐                              │
  │   │  AnthropicModelProviderAdapter     │   role: ModelProvider        │
  │   │    complete(request) →             │   adapts:                    │
  │   │      Anthropic.messages.create     │     anthropic SDK            │
  │   └────────────────────────────────────┘                              │
  │                                                                        │
  │   ┌─ Adapter 2 ────────────────────────┐                              │
  │   │  BloomingToolRegistryAdapter       │   role: ToolRegistry         │
  │   │    callTool/listTools →            │   adapts:                    │
  │   │      dataSource.callTool           │     DataSource (Blooming)    │
  │   └────────────────────────────────────┘                              │
  │                                                                        │
  │   ┌─ Adapter 3 ────────────────────────┐                              │
  │   │  BloomingTraceSinkAdapter          │   role: CapabilityTraceSink  │
  │   │    emit(event) →                   │   adapts:                    │
  │   │      hook.onToolCall/onText/...    │     Blooming hook callbacks  │
  │   └────────────────────────────────────┘                              │
  └────────────────────────────┬───────────────────────────────────────────┘
                               │
  ┌─ AptKit side ──────────────▼─────────────────────────────────────────┐
  │  AptKitDiagnosticInvestigationAgent.investigate(anomaly)            │
  │    ↓ drives:                                                         │
  │      model.complete(request) → AptKit knows ONLY the ModelProvider  │
  │      tools.callTool(name, args) → AptKit knows ONLY the ToolRegistry│
  │      trace.emit(event) → AptKit knows ONLY the TraceSink            │
  │    ↓ returns:                                                        │
  │      DiagnosticDiagnosis (AptKit's type)                            │
  └──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The **Adapter** pattern is one of the original 23 Gang of Four patterns (1994) — wrap an existing class so it conforms to the interface a different system expects. The textbook example was wiring a third-party shape class into a drawing library that expected a different interface.

The **Anti-Corruption Layer** is Eric Evans' framing in *Domain-Driven Design* (2003) for the same shape at a different scale. When two bounded contexts (in DDD terminology) have to integrate, you build a translation layer so neither context's vocabulary leaks into the other. The layer carries all of the impedance mismatch.

The combination matters here because this isn't a one-class adapter — it's *three* adapters, each playing a different AptKit role, all living in the same file. The cluster-in-one-file is the key: if the three adapters were spread across three different files, a future reader couldn't easily check that the wall is intact. Putting them together makes the wall scannable.

A note on the legacy mirror: `lib/agents/base-legacy.ts` (270 LOC) and the other `-legacy.ts` files in `lib/agents/` are the pre-AptKit implementation — they inlined what the bridge now hides. The new files (`base.ts`, `monitoring.ts`, `diagnostic.ts`, `recommendation.ts`, `query.ts`, `intent.ts`) are dramatically smaller (a combined ~280 LOC vs the legacy ~720 LOC). That's the measurable payoff of the bridge: ~440 LOC of translation pulled out of the agent layer, into one file, with the legacy mirror preserved during the migration. Once the two stranded test files are updated, the legacy mirror can go.

For the conceptual treatment of information hiding, read `.aipe/read-aposd/part-2/04-information-hiding.md`. The Ousterhout chapter doesn't use the term "anti-corruption layer" — but the principle (a module's purpose is to hide a decision) is the same one.

## Interview defense

### Q1: "Why three adapter classes? Couldn't this be one adapter that does everything?"

```
  the three roles AptKit asks for — separate by responsibility

  ┌─ ModelProvider ──────┐  ┌─ ToolRegistry ──────┐  ┌─ CapabilityTraceSink ┐
  │  request/response    │  │  list/call          │  │  push events         │
  │  (Anthropic API)     │  │  (DataSource port)  │  │  (hook callbacks)    │
  └──────────────────────┘  └─────────────────────┘  └──────────────────────┘
        ↑ one class            ↑ one class               ↑ one class
        per AptKit role,       per AptKit role,          per AptKit role.
        not one class for      not one mega-class
        all three.             for all three.
```

Because `@aptkit/core` exposes three distinct ports (`ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`) and the agent constructors take one of each. One mega-class would have to implement all three interfaces, and the responsibilities don't compose — request/response translation has nothing to do with event-pairing state. Splitting by role keeps each class small (the largest is 47 lines) and named after the AptKit interface it implements.

The deeper reason: AptKit's *agent classes* (e.g. `AptKitDiagnosticInvestigationAgent`) accept `{ model, tools, trace, workspace }` as separate constructor args. If we had one mega-class, we'd pass the same object three times. The shape of the dependency injection makes the three-class structure honest.

**Anchor:** one adapter per role AptKit asks for — request/response, tools, events.

### Q2: "How would you verify the wall is intact?"

```
  the integrity test — one grep, one read

  step 1:  grep -rn 'from .@aptkit/core' lib/ app/ components/
  expected: results ONLY in
              lib/agents/aptkit-adapters.ts (the bridge)
              lib/agents/monitoring.ts      (the agent class)
              lib/agents/diagnostic.ts      (the agent class)
              lib/agents/recommendation.ts  (the agent class)
              lib/agents/query.ts           (the agent class)
              lib/agents/intent.ts          (the classifier)
              lib/agents/categories.ts      (the category builder)
              lib/agents/base.ts            (the McpCaller type alias)

  step 2:  read each non-bridge import — what's imported?
  expected: ONLY the AptKit *agent classes* (the wrapped surface),
            never the *primitive types* (ModelProvider, ToolRegistry,
            CapabilityEvent — those should only appear in the bridge).
```

Two checks:

  1. `grep -rn 'from .@aptkit/core' lib/ app/ components/` — every match should be inside `lib/agents/`.
  2. Of those matches, each non-bridge file should import only the *agent classes* (`AptKitDiagnosticInvestigationAgent`, `AnomalyMonitoringAgent`, etc.), never the *primitive types* (`ModelProvider`, `ToolRegistry`, `CapabilityEvent`). The primitives should appear only in the bridge.

A leak would look like a UI hook or a route handler importing `CapabilityEvent` directly to type-check a callback — that would be the wall springing a hole.

**Anchor:** the wall is grep-able. One imported symbol outside `lib/agents/` is a finding.

### Q3: "What happens when AptKit ships a breaking change to `ModelProvider`?"

```
  the localized blast radius — what changes vs what doesn't

  ┌─ bumps to @aptkit/core@0.4.0 ─────────────────────────────────┐
  │  ModelProvider now requires `streamComplete(request)`         │
  │  in addition to `complete(request)`                           │
  └────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
  ┌─ changes ─────────────────────────────────────────────────────┐
  │  lib/agents/aptkit-adapters.ts                                │
  │    AnthropicModelProviderAdapter grows a `streamComplete`     │
  │    method that calls `anthropic.messages.stream(...)`         │
  └───────────────────────────────────────────────────────────────┘

  ┌─ does NOT change ─────────────────────────────────────────────┐
  │  lib/agents/monitoring.ts        (49 LOC, unchanged)          │
  │  lib/agents/diagnostic.ts        (49 LOC, unchanged)          │
  │  lib/agents/recommendation.ts    (40 LOC, unchanged)          │
  │  lib/agents/query.ts             (34 LOC, unchanged)          │
  │  app/api/briefing/route.ts       (unchanged)                  │
  │  app/api/agent/route.ts          (unchanged)                  │
  │  every UI hook                    (unchanged)                  │
  └───────────────────────────────────────────────────────────────┘
```

Exactly one file changes — `lib/agents/aptkit-adapters.ts`. The agent classes stay the same; the route handlers stay the same; the UI hooks stay the same; the demo replay stays the same.

That's the *whole point* of the bridge. If AptKit's bump required changes spread across `monitoring.ts`, `diagnostic.ts`, two route handlers, and a UI hook, the wall would be cosmetic. Because the wall is real, the blast radius is one file.

**Anchor:** the wall localises the blast radius. One file changes per AptKit bump.

## See also

  → `00-overview.md` — where the bridge sits in the agent layer.
  → `audit.md` — lens 3 (information-hiding-and-leakage) names this as the cleanest hide.
  → `01-port-and-adapter-data-source.md` — the bigger port-and-adapter pair (Blooming ↔ external data).
  → `04-page-decomposition-and-hooks.md` — the same translation discipline applied at the UI layer.
  → `.aipe/read-aposd/part-2/04-information-hiding.md` — the conceptual chapter.
  → `.aipe/read-aposd/part-2/03-deep-modules.md` — why "the bridge hides 440 LOC of translation" is the same pattern as the port.

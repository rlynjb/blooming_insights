# AptKit primitive boundary — three adapters between Blooming and a reusable agent library

**Industry name:** anti-corruption layer / adapter pattern · Industry standard

## Zoom out, then zoom in

The agents themselves — the monitoring scan, the diagnostic investigation,
the recommendation pipeline — don't live in this repo anymore. They live in
`@aptkit/core@0.3.0`. What lives here is a thin wrapper per agent
(`lib/agents/{monitoring,diagnostic,recommendation,query,intent}.ts`) plus
**three adapter classes** that translate between AptKit's
provider-neutral interfaces and Blooming's concrete types: Anthropic SDK,
DataSource, and the AgentEvent trace shape.

You know how a React component doesn't care whether the data came from a
REST endpoint, a GraphQL query, or a static file — the props are the
contract. Same shape here: AptKit's `AnomalyMonitoringAgent` takes a
`ModelProvider`, a `ToolRegistry`, and a `CapabilityTraceSink`. It
doesn't know it's Anthropic, doesn't know the data source is Bloomreach,
doesn't know the trace ends up as NDJSON. The three adapters in
`aptkit-adapters.ts` are what make that work.

```
  Zoom out — where the AptKit boundary lives

  ┌─ Route handler ────────────────────────────────────────────────────────┐
  │  new DiagnosticAgent(anthropic, dataSource, schema, allTools, sid)     │
  │    .investigate(anomaly, { onText, onToolCall, ..., signal })          │
  └──────────────────────────────┬─────────────────────────────────────────┘
                                 │
  ┌─ Blooming wrapper (lib/agents/diagnostic.ts) ────────────────────────┐
  │  Constructs three adapter instances + passes to AptKit:               │
  │    AnthropicModelProviderAdapter(anthropic, 'diagnostic', sid)        │
  │    BloomingToolRegistryAdapter(dataSource, allTools)                  │
  │    BloomingTraceSinkAdapter(hooks, 'diagnostic')                      │
  └──────────────────────────────┬─────────────────────────────────────────┘
                                 │
  ┌─ AptKit core ────────────────▼───────────────────────────────────────┐
  │  new AptKitDiagnosticInvestigationAgent({ model, tools, trace, ... }) │
  │    .investigate(anomaly, { signal })                                  │
  │  ★ THE AGENT LOOP LIVES HERE, in @aptkit/core@0.3.0 ★                │ ← we are here
  └───────────────────────────────────────────────────────────────────────┘
```

This is the same architectural move as the DataSource seam, one layer up.
There, the agents are blind to which adapter they got; here, AptKit is
blind to which SDK / data source / trace consumer it got.

## Structure pass — layers, axis, seams

**Layers:** Route handler → Blooming wrapper → 3 adapters → AptKit primitive
→ (back through adapters for outputs).

**Axis (held constant): "who owns which type?"** This is the right axis
because the whole boundary exists to translate between two
type-vocabularies that shouldn't know about each other.

```
  Axis: who owns which type?

  ┌─ Blooming type-vocabulary ─────────────────────────┐
  │  Anomaly, Diagnosis, Recommendation, ToolCall,     │   → BLOOMING owns
  │  AgentEvent, WorkspaceSchema (lib/mcp/types.ts)    │
  └──────────────────────────────┬─────────────────────┘
                                 │
  ┌─ 3 adapter classes ──────────▼─────────────────────┐
  │  bidirectional translation                          │   → ADAPTERS own
  │  toAnthropicMessage / toModelContentBlock           │     the mapping
  │  toBloomingToolCall                                 │
  └──────────────────────────────┬─────────────────────┘
                                 │
  ┌─ AptKit type-vocabulary ─────▼─────────────────────┐
  │  ModelMessage, ModelResponse, ModelTool,            │   → APTKIT owns
  │  ToolDefinition, CapabilityEvent (from @aptkit/core)│
  └────────────────────────────────────────────────────┘
```

**Seams (boundaries where type-ownership flips):**

- **Blooming wrapper ↔ AptKit primitive** — the API boundary. The wrapper
  exposes Blooming types in its constructor + method signatures
  (`Anthropic`, `DataSource`, `Anomaly`, `Diagnosis`); the adapter
  translates inbound at construct time and outbound at call time.
- **AptKit ↔ Anthropic SDK** — the model-provider boundary. AptKit calls
  `model.complete(request)`; the adapter calls `anthropic.messages.create(...)`.
- **AptKit ↔ DataSource** — the tool-execution boundary. AptKit calls
  `tools.callTool(name, args)`; the adapter forwards to
  `dataSource.callTool(name, args)`.
- **AptKit ↔ trace consumer** — the observability boundary. AptKit emits
  `CapabilityEvent`s; the adapter translates them into Blooming's hook
  shape (`onText` / `onToolCall` / `onToolResult`).

## How it works

### Move 1 — the mental model

An anti-corruption layer (Eric Evans, *Domain-Driven Design*) is the
formal name. The idea: when you depend on a third-party with its own
type vocabulary, don't let those types leak into your domain — translate
at the boundary. If the third-party renames a field tomorrow, only the
adapter changes; your domain stays still.

```
  Pattern — anti-corruption layer (one direction at a time)

       Blooming side                        AptKit side
       ─────────────                        ───────────
       Anthropic SDK         in:            ModelProvider
       (vendor)        ───►  adapt   ───►  (interface)
                                              │
       ToolCall, Anomaly,    out:            CapabilityEvent
       AgentEvent      ◄───  adapt   ◄───  (interface)
                       (3 adapter classes)
```

Three classes (because the AptKit interface has three orthogonal slots):

  → `AnthropicModelProviderAdapter` — bridges `ModelProvider` to Anthropic SDK
  → `BloomingToolRegistryAdapter` — bridges `ToolRegistry` to `DataSource`
  → `BloomingTraceSinkAdapter` — bridges `CapabilityTraceSink` to Blooming hooks

### Move 2 — the step-by-step walkthrough

#### Step 1 — the model-provider adapter

AptKit doesn't know about Anthropic. It only knows `ModelProvider`: a
single async `complete(request)` method returning a `ModelResponse`. The
adapter translates message shapes in both directions.

```typescript
// lib/agents/aptkit-adapters.ts:26-72 (abridged)
export class AnthropicModelProviderAdapter implements ModelProvider {
  readonly id = 'anthropic';
  readonly defaultModel: string;
  private readonly logSite: string;

  constructor(
    private readonly anthropic: Anthropic,
    agent: AgentName,
    private readonly sessionId?: string,
    model = AGENT_MODEL,
    logSite = `agents/${agent}:aptkit-model`,
  ) {
    this.defaultModel = model;
    this.logSite = logSite;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: this.defaultModel,
      max_tokens: request.maxTokens ?? 4096,
      messages: request.messages.map(toAnthropicMessage),
    };
    if (request.system) params.system = request.system;
    if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);

    const response = await this.anthropic.messages.create(
      params, request.signal ? { signal: request.signal } : undefined,
    );

    console.log(JSON.stringify({ site: this.logSite, sessionId: this.sessionId, usage: response.usage }));

    return {
      content: response.content.flatMap(toModelContentBlock),
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      model: response.model,
    };
  }
}
```

What this adapter hides from AptKit:

  → the `messages` shape (Anthropic uses `tool_use`/`tool_result` blocks
    nested inside an array of message-objects; AptKit's shape is
    structurally similar but distinct types)
  → the `system` parameter being separate from `messages`
  → the `usage` shape (Anthropic returns `input_tokens`/`output_tokens`;
    AptKit normalizes to `inputTokens`/`outputTokens`)
  → the per-call usage log line — emitted here, not in agent code,
    because the adapter is the only place that sees every call
    (`aptkit-adapters.ts:57-61`)

```
  Layers-and-hops — one ModelProvider.complete() round-trip

  ┌─ AptKit loop ────────────┐  request: ModelRequest    ┌─ Adapter ─────┐
  │  AnomalyMonitoringAgent  │ ───────────────────────►  │ map messages, │
  │  .scan() body             │                          │ tools, system │
  └──────────────────────────┘                           └──────┬────────┘
                                                                 │ anthropic.messages.create
                                                                 ▼
                                                          ┌─ Anthropic SDK ┐
                                                          │  POST /v1/...  │
                                                          └──────┬─────────┘
                                                                 │ Message
  ┌─ AptKit loop ────────────┐  ModelResponse            ┌──────▼────────┐
  │  AnomalyMonitoringAgent  │ ◄──────────────────────── │ map content,  │
  │  .scan() body             │                          │ normalize     │
  └──────────────────────────┘                           │ usage         │
                                                          └──────────────┘
```

#### Step 2 — the tool-registry adapter

AptKit knows `ToolRegistry`: `listTools()` returns metadata,
`callTool(name, args, opts)` executes one. The adapter forwards to a
`DataSource`.

```typescript
// lib/agents/aptkit-adapters.ts:74-97
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
    name: string, args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<{ result: unknown; durationMs: number }> {
    const { result, durationMs } = await this.dataSource.callTool(name, args, options);
    return { result, durationMs };
  }
}
```

Notice: this adapter drops `fromCache`. AptKit doesn't care; only the
trace UI does. The trace adapter (step 3 below) doesn't see
`fromCache` either — it only sees the `CapabilityEvent`s AptKit emits,
which don't carry it. **This is a real lossy boundary**: cache-hit
information stops at the adapter. If you wanted that information in the
UI, the agent-wrapper-level hooks would have to surface it separately.
Today they don't, and the trace's "via X" panel just shows tool name
+ duration.

#### Step 3 — the trace-sink adapter

This is the most complex of the three because it has to reconstruct
state across two events: AptKit emits `tool_call_start` and
`tool_call_end` separately, but Blooming's `ToolCall` object carries
both args (from start) and result+duration (from end). The adapter
maintains a per-toolName queue of in-flight calls.

```typescript
// lib/agents/aptkit-adapters.ts:100-142 (abridged)
export class BloomingTraceSinkAdapter implements CapabilityTraceSink {
  private readonly activeToolCalls = new Map<string, ToolCall[]>();

  constructor(
    private readonly hooks: AptKitAgentHooks,
    private readonly agent: AgentName,
  ) {}

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
      const toolCall = this.activeToolCalls.get(event.toolName)?.shift() ?? this.toBloomingToolCall(event);
      toolCall.durationMs = event.durationMs;
      toolCall.result = event.result;
      toolCall.error = event.error;
      this.hooks.onToolResult?.(toolCall);
    }
  }
}
```

The queue-per-toolName matters because the same tool can be in-flight
multiple times (the agent can decide to call `execute_analytics_eql`
twice with different `eql` args in parallel-ish). FIFO by name keeps
the start/end pairs correctly matched.

```
  Pattern — start/end pairing in the trace sink

  Map<toolName, ToolCall[]>:
    "execute_analytics_eql" : [ TC#1 (started), TC#2 (started) ]

  on tool_call_end for "execute_analytics_eql":
    shift() → TC#1, fill in result/duration, emit onToolResult(TC#1)
    Map becomes:
    "execute_analytics_eql" : [ TC#2 (still in-flight) ]

  on next tool_call_end:
    shift() → TC#2, fill in, emit
```

#### Step 4 — what the Blooming wrapper actually contains

With the three adapters in place, the wrappers reduce to construction +
call-forwarding. Here's `DiagnosticAgent` in full:

```typescript
// lib/agents/diagnostic.ts:26-45 (abridged)
export class DiagnosticAgent {
  constructor(
    private anthropic: Anthropic,
    private dataSource: McpCaller,
    private schema: WorkspaceSchema,
    private allTools: McpToolDef[],
    private sessionId?: string,
  ) {}

  async investigate(anomaly: Anomaly, hooks: AgentHooks = {}): Promise<Diagnosis> {
    const agent = new AptKitDiagnosticInvestigationAgent({
      model: new AnthropicModelProviderAdapter(this.anthropic, 'diagnostic', this.sessionId),
      tools: new BloomingToolRegistryAdapter(this.dataSource, this.allTools),
      workspace: this.schema,
      trace: new BloomingTraceSinkAdapter(hooks, 'diagnostic'),
    });
    return toBloomingDiagnosis(await agent.investigate(anomaly, { signal: hooks.signal }));
  }
}
```

What's left in this file is the Blooming-facing API — the constructor's
arguments, the method's name, the hook shape, the return type. AptKit
owns the loop body.

#### Step 5 — what the wrappers still own (not just forwarding)

A wrapper is more than a pass-through. The MonitoringAgent wrapper
additionally:

  → builds the compact schema summary (`schemaSummary`,
    `lib/agents/monitoring.ts:19-60`) — 20 events × 10 props × 30 customer
    properties, NOT the full 112KB schema
  → translates Blooming's `AnomalyCategory` shape (which carries
    `eql(projectId)` as a function) to AptKit's `MonitoringAnomalyCategory`
    (which carries `queryRecipe` as a string) — `monitoring.ts:96-109`
  → translates AptKit's `MonitoringAnomaly` back to Blooming's
    `Anomaly` (just a type widen for the `category` field) —
    `monitoring.ts:111-116`

These are domain translations, not just API forwarding. They prove the
adapter pattern isn't a thin shim — it's a translation layer with real
content.

### Move 2.5 — the `-legacy.ts` siblings

Every wrapper has a `*-legacy.ts` sibling preserved for reference. The
hand-rolled agent loop is in `lib/agents/base-legacy.ts` (270 LOC).
These files aren't wired into routes; they exist so the migration is
reversible if AptKit ever needs to be replaced. The numbers:

```
  Pre-migration vs post-migration line counts

  File                       LOC   wired?
  ───                        ───   ──────
  base.ts                     14   yes (just McpCaller + AGENT_MODEL)
  base-legacy.ts             270   no (runAgentLoop preserved)
  monitoring.ts              116   yes
  monitoring-legacy.ts       138   no
  diagnostic.ts               49   yes
  diagnostic-legacy.ts       112   no
  recommendation.ts           40   yes
  recommendation-legacy.ts   105   no
  query.ts                    34   yes
  query-legacy.ts             53   no
  intent.ts                   38   yes
  intent-legacy.ts            42   no
  aptkit-adapters.ts         206   yes (the new boundary)
```

The wrappers collectively shrank by ~60% while the boundary code
(aptkit-adapters.ts, 206 LOC) is new. Net: the codebase is smaller and
the agent loop is no longer Blooming's problem.

### Move 3 — the principle

**An anti-corruption layer is what makes a vendor swap survivable.**
If a future @aptkit/core@0.4 ships breaking changes to its
`ModelProvider` interface, only `aptkit-adapters.ts:26-72` changes.
The wrappers don't change. The agents in the routes don't change. The
UI doesn't change. That's the test.

The general principle, beyond this codebase: when you're integrating
with a library whose interfaces are stable but whose internals are
not, put the interface in your code (the wrapper's signature) and put
the translation in a single named place (the adapter). When the
library moves, you change one file.

It's the same shape as the DataSource seam in `03-datasource-seam.md`,
applied one layer up. Both files teach the same lesson; the difference
is where the seam sits — DataSource between agents and providers,
AptKit primitive between Blooming wrappers and the agent loop itself.

## Primary diagram

```
  AptKit primitive boundary — one DiagnosticAgent.investigate() call

  ┌─ Route handler ──────────────────────────────────────────────────────────┐
  │  new DiagnosticAgent(anthropic, dataSource, schema, allTools, sid)        │
  │    .investigate(anomaly, { onText, onToolCall, onToolResult, signal })    │
  └──────────────────────────────┬───────────────────────────────────────────┘
                                 │
  ┌─ Blooming wrapper (lib/agents/diagnostic.ts) ───────────────────────────┐
  │  Constructs the 3 adapters + AptKit agent:                                │
  │                                                                            │
  │   ┌─ AnthropicModelProviderAdapter ──┐  implements ModelProvider           │
  │   │  complete(request) →              │                                    │
  │   │   anthropic.messages.create(...)  │                                    │
  │   │   + log usage                     │                                    │
  │   └───────────────────────────────────┘                                    │
  │                                                                            │
  │   ┌─ BloomingToolRegistryAdapter ────┐  implements ToolRegistry            │
  │   │  listTools() → allTools.map(...)  │                                    │
  │   │  callTool(name, args, opts) →     │                                    │
  │   │   dataSource.callTool(...)        │                                    │
  │   └───────────────────────────────────┘                                    │
  │                                                                            │
  │   ┌─ BloomingTraceSinkAdapter ───────┐  implements CapabilityTraceSink     │
  │   │  emit(event) →                    │                                    │
  │   │   queue-per-toolName for start/end│                                    │
  │   │   → call hooks.onToolCall/Result/Text                                  │
  │   └───────────────────────────────────┘                                    │
  └──────────────────────────────┬───────────────────────────────────────────┘
                                 │
  ┌─ AptKit core ────────────────▼───────────────────────────────────────────┐
  │  AptKitDiagnosticInvestigationAgent                                       │
  │    while not done:                                                        │
  │      response = await model.complete({ messages, tools, signal })         │
  │      for block in response.content:                                       │
  │        if block.type === 'tool_use':                                      │
  │          trace.emit({ type: 'tool_call_start', toolName, args, ... })     │
  │          result = await tools.callTool(toolName, args, { signal })         │
  │          trace.emit({ type: 'tool_call_end',   toolName, ..., result })   │
  │          append tool_result to messages                                   │
  │        if block.type === 'text':                                          │
  │          trace.emit({ type: 'step', content: block.text })                │
  │      done = (no tool_use in response)                                     │
  │    return parsed Diagnosis                                                 │
  └───────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where this pattern comes from.** Anti-corruption layer is Eric Evans'
term (*Domain-Driven Design*, 2003). The motivation: when two domains
(yours and a vendor's) have different vocabularies for the same
concepts, allowing the vendor's vocabulary to spread through your code
ties your domain model to their release cycle. The adapter localizes
the contamination at the boundary.

**The deeper principle.** Separation of concerns by *who owns the
shape*. Anthropic owns the `Message` shape; AptKit owns the
`ModelMessage` shape; Blooming owns the `ToolCall` shape. The adapter
is where ownership flips. The boundary works because each side can
evolve its own shape independently — the adapter absorbs the change.

**Where it breaks.**

- **Lossy boundaries.** `BloomingToolRegistryAdapter` drops
  `fromCache` because AptKit's `callTool` return doesn't have a slot
  for it. Cache-hit information stops at the adapter; the trace UI
  doesn't know which calls hit the 60s cache. The wrapper-level hooks
  could carry it separately, but today don't.
- **State across events.** `BloomingTraceSinkAdapter` reconstructs
  start/end pairing via a `Map<toolName, ToolCall[]>`. If AptKit ever
  emits events out of order (start B, start A, end A, end B) the
  FIFO-by-name scheme corrupts pairing. Today AptKit's loop is
  sequential per tool call so this doesn't happen, but it's a latent
  coupling to AptKit's emission order.
- **The wrappers' constructor signatures are wide.** Each wrapper takes
  `(anthropic, dataSource, schema, allTools, sid)` — five things. A
  builder or a context object would clean this up; today the route
  handler passes the same five to every agent constructor it builds.

**What to explore next.**

- `03-datasource-seam.md` — the same anti-corruption pattern one layer
  down (DataSource is to agents what ModelProvider is to AptKit)
- `07-multi-agent-orchestration.md` — how the route uses these wrappers
- `06-streaming-ndjson.md` — what the trace adapter's hook calls produce

## Interview defense

#### Q: "Why three adapter classes instead of one big bridge?"

Because AptKit's interface has three orthogonal slots and they have
different lifetimes. `ModelProvider` is per-agent and tied to the
Anthropic SDK; `ToolRegistry` is per-agent and tied to the DataSource;
`CapabilityTraceSink` is per-call and tied to the hooks the route
handler builds for THIS request. Bundling them into one class would
couple their construction order — the model provider would suddenly
need to know about hooks it doesn't use.

```
  Three adapters, three independent decisions

  ModelProvider         ToolRegistry        CapabilityTraceSink
  ─────────────         ────────────        ───────────────────
  Anthropic vs other    Bloomreach vs       NDJSON hooks vs
  SDK                   Synthetic           future trace stores
  swappable per agent   swappable per req   swappable per request
```

**Surface:** "three slots, three adapters, independent lifetimes."
**Probe:** if pressed, point to the trace-sink adapter as the only one
that holds state across events (the start/end queue) and explain why
it can't be merged with the others.

#### Q: "What's the load-bearing part — what breaks if you remove any of these adapters?"

The `BloomingTraceSinkAdapter`'s start/end pairing
(`aptkit-adapters.ts:114-129`). It's the kernel: a `Map<toolName,
ToolCall[]>` that buffers tool_call_start events until the matching
tool_call_end arrives, so the merged `ToolCall` carries both args (from
start) and result+duration (from end).

```
  load-bearing skeleton — start/end pairing

  on tool_call_start(toolName, args):
    queue = activeToolCalls.get(toolName) ?? []
    queue.push(new ToolCall(args))
    emit onToolCall  (UI sees: tool started)

  on tool_call_end(toolName, durationMs, result, error):
    toolCall = activeToolCalls.get(toolName).shift()     ← LOAD-BEARING
    toolCall.durationMs = ...
    toolCall.result = ...
    emit onToolResult (UI sees: tool finished with this result)
```

Drop the queue and concurrent calls to the same tool would either
overwrite each other's args or attach the wrong result to the wrong
call. The UI's "via X" trace would lie.

Other load-bearing parts:

  → `toAnthropicMessage` / `toModelContentBlock` — the bidirectional
    SDK translation; without them, AptKit's `ModelMessage` and
    Anthropic's `Message` are different objects and the agent loop
    can't run
  → the `complete()` signature on the adapter — without it, AptKit
    can't call the model at all
  → `request.signal ? { signal: request.signal } : undefined` — passes
    cancellation through; without it, `req.signal` from the route
    doesn't reach the Anthropic SDK

Optional hardening:

  → the per-call usage log line — useful for cost telemetry, but the
    adapter runs without it
  → the per-agent `logSite` — distinguishes which agent made the call
    in logs

#### Q: "AptKit shipped 0.3.0. What's your migration story when 0.4 lands?"

Three files change, at most. **One**: `aptkit-adapters.ts` — if AptKit
renames `complete()` to `chat()` or adds a required field to
`ModelResponse`, the adapters absorb it. **Two**: any wrapper whose
AptKit constructor changed (e.g. if `AptKitDiagnosticInvestigationAgent`
gains a new required option). **Three**: maybe `lib/agents/base.ts` if
AGENT_MODEL needs to change.

The route handlers don't change. The DataSource seam doesn't change.
The hooks don't change. The NDJSON contract doesn't change. The UI
doesn't change. That's the value of the anti-corruption layer — the
blast radius of a vendor change is bounded to a known set of files.

## See also

- `00-overview.md` — where this sits in the whole system
- `03-datasource-seam.md` — the same pattern one layer down
- `07-multi-agent-orchestration.md` — how the wrappers compose into pipelines
- `06-streaming-ndjson.md` — what the trace adapter's hooks produce
- `01-request-flow.md` — where the wrappers get constructed

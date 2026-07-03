# The aptkit bridge — three adapters, one dependency fence

Adapter bundle · Information hiding · Language-agnostic

## Zoom out — where this concept lives

You know how a React component that talks to an API usually
sticks the `fetch()` call in one hook so the rest of the tree
doesn't know a network exists? Same instinct here, applied one
layer up. `aptkit` is the framework that owns the ReAct loop; the
Anthropic SDK is the vendor that owns the model call. This repo
fences both of them inside one file, and every agent imports the
three adapter classes from that file as a bundle.

```
  Zoom out — where the aptkit bridge sits

  ┌─ Client layer (agents) ──────────────────────────────┐
  │  MonitoringAgent · DiagnosticAgent ·                 │
  │  RecommendationAgent · QueryAgent                    │
  └────────────────────────┬─────────────────────────────┘
                           │  imports the three-adapter bundle
  ┌─ Bridge layer ────────▼──────────────────────────────┐
  │  ★ aptkit-adapters.ts ★  (263 LOC, one file)          │ ← you are here
  │     AnthropicModelProviderAdapter                     │
  │     BloomingToolRegistryAdapter                       │
  │     BloomingTraceSinkAdapter                          │
  └────────────────────────┬─────────────────────────────┘
                           │  fences these SDKs
  ┌─ Vendor layer ────────▼──────────────────────────────┐
  │  @anthropic-ai/sdk         (Messages API)             │
  │  @aptkit/core              (agent loop + trace sink)  │
  └──────────────────────────────────────────────────────┘
```

The fence is load-bearing. Delete any one of the three adapter
classes and the agents would have to import both SDKs directly.

## Structure pass

**Layers.** Three: client (agents), bridge (this file), vendor
(the two SDKs). The bridge is the interesting layer — it's
neither client nor vendor; it exists so those two layers never
touch.

**Axis: dependency direction.** Above the bridge, imports flow
down (agents import adapters). Below the bridge, imports also
flow down (adapters import SDKs). The bridge is the only place
where both dependencies coexist. Delete the bridge and the
diamond collapses back to direct agent → SDK edges.

**Seams.** Two, one on each face:
- upper seam — `AptKitAgentHooks` (the shape the agents pass in)
- lower seam — aptkit's `ModelProvider`, `ToolRegistry`,
  `CapabilityTraceSink` interfaces (the shapes the adapters
  satisfy)

Both seams are load-bearing because the identity of the vendor
flips across them.

## How it works

### Move 1 — the mental model

Three adapters, one bundle, three vendor types hidden. Same
adapter *pattern* as `DataSource` (see `01-datasource-port.md`),
but instead of one port with one interface, aptkit hands you
three interfaces and you write three adapter classes. Bundled
together they're the entire fence.

```
  The three-adapter bundle — one file, three seams

  ┌─────────────────────────────────────────────────────────────┐
  │  aptkit-adapters.ts                                          │
  │                                                              │
  │  ┌─── AnthropicModelProviderAdapter ────┐                    │
  │  │  implements ModelProvider (aptkit)   │  ← Anthropic SDK  │
  │  │  hides: message shape, tool shape,   │    fenced here     │
  │  │         cache-control, budget check  │                    │
  │  └──────────────────────────────────────┘                    │
  │                                                              │
  │  ┌─── BloomingToolRegistryAdapter ──────┐                    │
  │  │  implements ToolRegistry (aptkit)    │  ← DataSource     │
  │  │  hides: how a tool call is dispatched │    fenced here    │
  │  └──────────────────────────────────────┘                    │
  │                                                              │
  │  ┌─── BloomingTraceSinkAdapter ─────────┐                    │
  │  │  implements CapabilityTraceSink      │  ← aptkit event   │
  │  │  hides: event → Blooming ToolCall     │    shape fenced   │
  │  │         mapping; optional forward     │                    │
  │  └──────────────────────────────────────┘                    │
  └─────────────────────────────────────────────────────────────┘
       ▲
       │  every agent imports these three; nothing else
       │
  ┌────┴─────────────────────────────────────────────────┐
  │  monitoring.ts · diagnostic.ts · recommendation.ts   │
  └──────────────────────────────────────────────────────┘
```

The reason this shows up together is that aptkit's `Agent`
constructor takes a `model`, a `tools`, and a `trace` — you
can't satisfy the framework without producing all three.

### Move 2 — the walkthrough

**Adapter 1 — `AnthropicModelProviderAdapter`.** Wraps the
Anthropic SDK's `messages.create` behind aptkit's `ModelProvider`
interface. This is the heaviest adapter in the file (~120 LOC of
the total 263).

```typescript
// lib/agents/aptkit-adapters.ts:35-57 (constructor)
export class AnthropicModelProviderAdapter implements ModelProvider {
  readonly id = 'anthropic';
  readonly defaultModel: string;
  private readonly logSite: string;

  constructor(
    private readonly anthropic: Anthropic,        // ← Anthropic SDK
    agent: AgentName,
    private readonly sessionId?: string,
    model = AGENT_MODEL,
    logSite = `agents/${agent}:aptkit-model`,
    private readonly budget?: BudgetTracker,      // ← optional hook
  ) { /* ... */ }
```

Annotation:
- Line 42 — the SDK client is stored as private, never re-exposed.
- Line 47-52 — `model` and `logSite` have defaults; nothing outside
  this file names either. See audit lens 5 for the "6 positional
  args" red flag.
- Line 53 — the optional `BudgetTracker` (see `04-optional-hooks.md`).

```typescript
// lib/agents/aptkit-adapters.ts:59-120 (complete method — abridged)
async complete(request: ModelRequest): Promise<ModelResponse> {
  if (this.budget?.exceeded()) {
    throw new BudgetExceededError(this.budget.snapshot(), this.budget.limit);
  }

  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: this.defaultModel,
    max_tokens: request.maxTokens ?? 4096,
    messages: request.messages.map(toAnthropicMessage),  // ← converter
  };

  if (request.system) {
    params.system = [
      { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
    ];
  }
  if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);

  const response = await this.anthropic.messages.create(
    params,
    request.signal ? { signal: request.signal } : undefined,
  );

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

Annotation:
- Line 64-66 — budget check *before* the call. See `04-optional-hooks.md`.
- Line 72, 90 — private helpers `toAnthropicMessage` /
  `toAnthropicTool` convert aptkit-shaped requests into Anthropic-
  shaped requests. These helpers stay in this file (line 198-256).
  They're the one place that names both type surfaces.
- Line 86-89 — the cache-control breakpoint on the system prompt.
  The Anthropic-specific caching decision lives here, not in the
  agent that assembled the prompt.
- Line 113 — `toModelContentBlock` converts back. Same story:
  private, file-local, one direction each.

**Adapter 2 — `BloomingToolRegistryAdapter`.** The thin one. Wraps
the `DataSource` port (see `01-datasource-port.md`) as aptkit's
`ToolRegistry`.

```typescript
// lib/agents/aptkit-adapters.ts:123-146
export class BloomingToolRegistryAdapter implements ToolRegistry {
  constructor(
    private readonly dataSource: McpCaller,       // ← the DataSource port
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

Annotation:
- Line 138-145 — this looks like a pass-through method, but it
  isn't. The port returns `{ result, durationMs, fromCache }`; the
  aptkit registry expects `{ result, durationMs }`. The adapter
  drops the `fromCache` field. That's the whole point of the
  bridge — trim the port's return shape to match aptkit's
  expected shape. One field difference, but the field would
  break the framework's type-check if leaked.

**Adapter 3 — `BloomingTraceSinkAdapter`.** Bridges aptkit's
event stream back into Blooming's existing hooks (streamed to
the UI's StatusLog).

```typescript
// lib/agents/aptkit-adapters.ts:149-184
export class BloomingTraceSinkAdapter implements CapabilityTraceSink {
  private readonly activeToolCalls = new Map<string, ToolCall[]>();

  constructor(
    private readonly hooks: AptKitAgentHooks,
    private readonly agent: AgentName,
  ) {}

  emit(event: CapabilityEvent): void {
    this.hooks.onCapabilityEvent?.(event);   // ← additive Phase-2 hook

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
```

Annotation:
- Line 161 — the additive Phase-2 hook. Fires *before* the
  per-type routing, so callers who want the raw aptkit event
  stream can subscribe without breaking existing consumers. See
  `04-optional-hooks.md` for the pattern.
- Line 163-183 — three event kinds, each mapped to a Blooming-side
  hook. `step` → `onText`; `tool_call_start` → `onToolCall`;
  `tool_call_end` → `onToolResult`. The mapping table itself is
  hidden from the agents — they subscribe to Blooming hooks and
  never learn aptkit's event vocabulary.
- Line 150 — `activeToolCalls` map tracks concurrent tool calls
  by name so the `end` event can be paired to its `start`. This
  is real state, hidden entirely from callers.

**How the bundle imports look at a call site.**

```typescript
// lib/agents/diagnostic.ts:7-11
import {
  AnthropicModelProviderAdapter,
  BloomingToolRegistryAdapter,
  BloomingTraceSinkAdapter,
} from './aptkit-adapters';
```

Same three classes imported by monitoring, diagnostic,
recommendation. No agent ever imports `@aptkit/core` types
except through this bundle. No agent ever imports
`@anthropic-ai/sdk` except through `AnthropicModelProviderAdapter`.
Grep confirms it — this is the only file with both imports.

### Move 3 — the principle

Information hiding, at the module altitude: **when a single
external dependency exposes multiple interfaces you have to
satisfy together, bundle the adapters into one file so they can
share private converters and the dependency has one point of
entry.** Splitting them into three separate files would force
the converter helpers into a shared module or duplicate them
across files. Keeping the bundle whole is the version of
information-hiding that survives multi-interface vendors.

## Primary diagram

```
  aptkit-adapters.ts — one file, three seams, one dependency fence

  ┌─ agents (client) ────────────────────────────────────────────┐
  │  monitoring · diagnostic · recommendation · query            │
  └──────────┬───────────────────────────────────────────────────┘
             │  import { A, B, C } from './aptkit-adapters'
             ▼
  ┌─ aptkit-adapters.ts ─────────────────────────────────────────┐
  │                                                              │
  │  class A: AnthropicModelProviderAdapter                      │
  │    implements ModelProvider           ─────── aptkit surface │
  │    private uses: Anthropic SDK        ─────── vendor surface │
  │    private helpers: toAnthropicMessage, toAnthropicTool,     │
  │                     toModelContentBlock                      │
  │                                                              │
  │  class B: BloomingToolRegistryAdapter                        │
  │    implements ToolRegistry            ─────── aptkit surface │
  │    private uses: DataSource port      ─── Blooming-owned     │
  │                                                              │
  │  class C: BloomingTraceSinkAdapter                           │
  │    implements CapabilityTraceSink     ─────── aptkit surface │
  │    private state: activeToolCalls map                        │
  │    fires: hooks.onCapabilityEvent (additive)                 │
  │           hooks.onText / onToolCall / onToolResult           │
  │                                                              │
  └──────────┬───────────────────────┬───────────────────────────┘
             │                       │
             ▼                       ▼
  ┌─ @anthropic-ai/sdk ──┐  ┌─ @aptkit/core ─────────────────────┐
  │  Messages.create()   │  │  ModelProvider · ToolRegistry ·    │
  │  Messages type tree  │  │  CapabilityTraceSink · Agents      │
  └──────────────────────┘  └────────────────────────────────────┘
       ▲                          ▲
       │  ONLY imported here      │  ONLY imported here
       │  (dependency fence)      │  (dependency fence)
       └──────────────────────────┘
```

## Elaborate

The pattern in the literature is called *anti-corruption layer*
(Domain-Driven Design), *adapter* (Gang of Four), or *bridge*
(also GoF, closely related). What they share: you own the
interface on your side of the boundary; the vendor owns the
interface on the other side; the layer between exists to keep
the vendor's shape from corrupting your model.

The specific version here — three adapters bundled in one file —
is a shape you see whenever a framework hands you multiple
interfaces to satisfy for one thing. Web-framework middleware
often looks like this (handler + registry + logger, all
implemented against one framework). GraphQL server-side often
looks like this (resolver + schema + context). The bundle is the
right unit when the interfaces are cohesive.

What this codebase adds: the bundle grew from ~100 LOC (Week 2)
to 263 LOC (Week 4) by absorbing three new concerns —
observability (`onCapabilityEvent`), caching (the ephemeral
cache-control), and budgeting (`BudgetTracker`) — without
changing its shape or its call sites. That's what the fence
enables. If the adapters had been split across three files, the
`BudgetTracker` addition alone would have touched two of them.

## Interview defense

**Q: Why bundle three adapters in one file? Isn't that a "god file"?**
Because they share private converters and they share the vendor
dependency. Splitting them across three files would either
duplicate the converters (`toAnthropicMessage`, `toAnthropicTool`,
`toModelContentBlock` all live at file-scope, not on any one
adapter) or force them into a fourth shared module which nothing
outside would use. The bundle is the right cohesion unit — every
class in it satisfies an aptkit interface, and every class needs
the same private helpers.

At 263 LOC it isn't a god file. A god file has ten unrelated
concerns. This has three tightly-related ones and grew from 100
by absorbing observability + caching + budgeting *without
changing its shape*. That's the fence working.

**Q: What breaks if you drop `BloomingTraceSinkAdapter`?**
Every UI status log stops updating during an agent run. aptkit's
event stream is the only source of `tool_call_start` /
`tool_call_end` / `step` events, and this adapter is the only
translator into Blooming's `ToolCall` shape. Delete it and the
agents work; the StatusLog goes silent.

**Q: What's the load-bearing part people forget?**
The private helper functions at file-scope (`toAnthropicMessage`,
`toAnthropicTool`, `toModelContentBlock`). They're not on any
class; they're module-private. That placement is what makes the
bundle work as a single fence — if you moved them to a shared
`converters.ts`, you'd need to import the Anthropic SDK's types
from there too, and the fence would develop a hole.

**Q: What would you do differently?**
The `AnthropicModelProviderAdapter` constructor takes six
positional args and the two call sites both pass `undefined,
undefined` for the middle two (`diagnostic.ts:52-54`,
`recommendation.ts:36-38`). Convert to a named-options object.
The rest of the file is fine.

## See also

- `01-datasource-port.md` — the *lower* seam under the agents,
  running the same ports-and-adapters pattern one layer down.
- `04-optional-hooks.md` — how `onCapabilityEvent` and `budget`
  were added to this bundle without breaking existing callers.
- `.aipe/read-aposd/` — the book chapter on information hiding.

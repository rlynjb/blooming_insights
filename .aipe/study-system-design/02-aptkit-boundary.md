# port-and-adapter — the AptKit boundary

*Industry standard.* The same port-and-adapter pattern as `01-datasource-seam.md`, applied one altitude up. This time the ports are provided by `@aptkit/core` (Blooming's own runtime library, published to npm), and the adapters are Blooming's three-class bridge that turns Blooming's specific tools (Anthropic SDK, `DataSource`, in-app trace hooks) into the provider-neutral shape AptKit expects.

## Zoom out, then zoom in

You've got a runtime library (`@aptkit/core@0.3.0`) with its own vocabulary: `ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`. Blooming's application code speaks a different vocabulary: `Anthropic` client, `DataSource` interface, `onToolCall`/`onText`/`onCapabilityEvent` hook shapes. Three small classes in one file (`lib/agents/aptkit-adapters.ts`, 260 LOC) translate between them.

```
  Zoom out — where the AptKit boundary sits

  ┌─ UI layer ──────────────────────────────────────────────────┐
  │  StatusLog · ReasoningTrace · InsightCard · EvidencePanel   │
  └─────────────────────────────────────────────────────────────┘
                              │
  ┌─ Route layer ─────────────▼─────────────────────────────────┐
  │  /api/briefing · /api/agent                                  │
  └─────────────────────────────────────────────────────────────┘
                              │
  ┌─ Agent layer ─────────────▼─────────────────────────────────┐
  │  MonitoringAgent · DiagnosticAgent · RecommendationAgent    │
  │  (thin Blooming wrappers around AptKit agent classes)       │
  └─────────────────────────────────────────────────────────────┘
                              │
  ┌─ Adapter layer ───────────▼─────────────────────────────────┐
  │             ★ THE APTKIT BOUNDARY ★                          │  ← we are here
  │   AnthropicModelProviderAdapter  → ModelProvider port        │
  │   BloomingToolRegistryAdapter    → ToolRegistry port         │
  │   BloomingTraceSinkAdapter       → CapabilityTraceSink port  │
  └─────────────────────────────────────────────────────────────┘
                              │
  ┌─ Provider layer ──────────▼─────────────────────────────────┐
  │  @aptkit/core — provider-neutral agent primitives            │
  │    AnomalyMonitoringAgent · DiagnosticInvestigationAgent…    │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in. Three ports, three adapters, one file. The whole reason this bridge exists: AptKit has no idea Blooming uses Anthropic, or that Blooming has a `DataSource` seam under it, or that Blooming's UI wants tool calls to become `ToolCall` records with agent tags. The bridge is where "Blooming's world" becomes "AptKit's world" and vice versa.

## Structure pass

**Layers:** the *Blooming layer* above (route handlers, `DataSource`, `AptKitAgentHooks`) and the *AptKit layer* below (`@aptkit/core`'s primitives). The adapter layer is the joint between them.

**Axis:** *vocabulary*. Above the seam, everyone speaks Blooming (`Anthropic`, `DataSource`, `ToolCall`, `AgentName`). Below, everyone speaks AptKit (`ModelRequest`, `ModelResponse`, `ToolDefinition`, `CapabilityEvent`).

**Seam:** the three ports at the top of `lib/agents/aptkit-adapters.ts` — imports from `@aptkit/core` at lines 1-14, and the three classes that `implements` them.

```
  Structure pass — one axis (vocabulary) across the seam

  Blooming layer                  Blooming vocabulary
  ┌──────────────────────────┐    ─ Anthropic SDK client
  │  DiagnosticAgent          │    ─ DataSource (McpCaller)
  │  MonitoringAgent          │    ─ ToolCall { id, agent, toolName, args }
  │  RecommendationAgent      │    ─ AgentName = 'monitoring' | ...
  │  route handlers           │    ─ AptKitAgentHooks
  └──────────────┬───────────┘
                 │
  ─ seam ────────┼────────────  three ports (imported from @aptkit/core)
                 │              ─ ModelProvider
                 │              ─ ToolRegistry
                 │              ─ CapabilityTraceSink
                 ▼
  ┌──────────────────────────┐    AptKit vocabulary
  │  AnomalyMonitoringAgent   │    ─ ModelRequest { messages, tools, system }
  │  DiagnosticInvestigation- │    ─ ModelResponse { content, usage, model }
  │  Agent                    │    ─ ToolDefinition { name, description }
  │  ...                      │    ─ CapabilityEvent { type: step | tool_call_start | ... }
  └──────────────────────────┘

  same axis flips at the same seam: each vocabulary lives on its own side
  translation runs at the seam and nowhere else
```

This is the same shape as `01-datasource-seam.md`. What differs is *which vocabularies meet* and *which direction the port arrows point*. In `01-`, Blooming owns the port and the outside world owns the adapters. In `02-`, `@aptkit/core` owns the ports and Blooming owns the adapters. That inversion is worth noticing: **the same pattern can be applied with either side owning the port**, and which side owns it decides who can evolve without breaking whom.

## How it works

### Move 1 — the mental model

You've written a `useState` component that takes a callback prop. The parent decides *what happens*; the component decides *when to call*. The callback is a tiny port; the parent's function is the adapter.

Here, `@aptkit/core` is the "component" — it decides *when* to call a model, *when* to invoke a tool, *when* to emit a trace event. Blooming is the "parent" — it decides *what* the model call does (`Anthropic.messages.create`), *what* the tool call does (`dataSource.callTool`), *what* the trace event becomes (a `ToolCall` sent through `onToolResult`).

```
  The three-port bridge — one class per port

  ┌─ @aptkit/core (the runtime) ─────────┐
  │   AnomalyMonitoringAgent, etc.        │
  │      needs:                           │
  │        ModelProvider  ─ "run a turn"  │
  │        ToolRegistry   ─ "run a tool"  │
  │        CapabilityTraceSink ─ "trace"  │
  └───────────┬──────────────┬──────┬────┘
              │              │      │
              │ implements   │      │
              ▼              ▼      ▼
     ┌────────────────┐ ┌─────────┐ ┌───────────────────┐
     │ AnthropicModel │ │ Blooming│ │ BloomingTraceSink │
     │ ProviderAdapter│ │ ToolReg │ │ Adapter            │
     └───────┬────────┘ └────┬────┘ └─────────┬────────┘
             │               │                │
             ▼               ▼                ▼
     ┌────────────┐   ┌──────────┐   ┌──────────────┐
     │ Anthropic  │   │ DataSource│   │ AptKit-      │
     │ SDK        │   │ (port)    │   │  AgentHooks   │
     └────────────┘   └──────────┘   └──────────────┘

  three separate ports because they change independently:
    · model can swap (Anthropic → OpenAI) without touching tools
    · tools can swap (Bloomreach → Synthetic) without touching model
    · trace hooks change per surface (route vs eval) without touching either
```

### Move 2 — the walkthrough

**Adapter #1 — the model.** `AnthropicModelProviderAdapter` (`lib/agents/aptkit-adapters.ts:35-121`) implements AptKit's `ModelProvider` port. AptKit calls `complete(request)`; the adapter translates AptKit's provider-neutral `ModelRequest` into an Anthropic-specific `Messages.MessageCreateParamsNonStreaming`, dispatches, and translates the response back.

Three load-bearing behaviors ride *inside* this adapter, invisible to AptKit:

*Prompt caching* (`lib/agents/aptkit-adapters.ts:83-89`). The system prompt is stable across every model turn in an investigation. Wrapping it in `cache_control: { type: 'ephemeral' }` makes the first turn a cache_creation and every subsequent turn within 5 min a cache_read. For a ~10-turn diagnostic that's an ~80% reduction on system-prompt token cost. AptKit's `ModelRequest` doesn't have a `cacheControl` field — the caching lives *entirely* inside the adapter, and AptKit is happy.

*Budget-ceiling gate* (`lib/agents/aptkit-adapters.ts:63-66`). Before every dispatch, the adapter checks `this.budget?.exceeded()` and throws `BudgetExceededError` if the tracker's already burned past the limit. This means a runaway ReAct loop can't accumulate cost after the ceiling has been hit — the *next* turn refuses to fire. Details in `06-budget-and-observability.md`.

*Usage accumulation* (`lib/agents/aptkit-adapters.ts:106-110`). After every response, `this.budget?.add({ inputTokens, outputTokens })` feeds the tracker so the next turn's check has current data. Uses raw `input_tokens` (not cache-read tokens, which AptKit's `model_usage` event doesn't expose), so the tracker is slightly conservative when caching is on — it undercounts the cache-read fraction. That's a deliberate approximation, called out in a code comment.

**Adapter #2 — the tools.** `BloomingToolRegistryAdapter` (`lib/agents/aptkit-adapters.ts:124-146`) implements AptKit's `ToolRegistry`. Two methods:

```typescript
listTools(): ToolDefinition[]                 // pass-through of the McpToolDef[]
callTool(name, args, options): {              // pass-through to DataSource.callTool
  result: unknown;
  durationMs: number;
}
```

That's it. No caching, no rate limiting, no retry — those live *below* this adapter in `BloomreachDataSource`. The tool registry doesn't know or care what's under `this.dataSource`. This is the boundary the DataSource seam (`01-`) is being *used through*.

Notice the shape difference: AptKit's `callTool` expects `{ result, durationMs }` — no `fromCache`. That field lives on `DataSourceCallResult` for Blooming's own trace panel but AptKit doesn't need it. So the adapter drops it. This kind of drop-a-field, add-a-field translation is the entire reason the adapter exists.

**Adapter #3 — the trace.** `BloomingTraceSinkAdapter` (`lib/agents/aptkit-adapters.ts:149-196`) implements AptKit's `CapabilityTraceSink`. AptKit emits `CapabilityEvent`s of six kinds; the adapter routes each to Blooming's UI hook (`onText`, `onToolCall`, `onToolResult`) plus — additively — the raw `onCapabilityEvent` hook for callers that want the untranslated stream.

```
  Trace translation — one AptKit event, two Blooming callbacks

     AptKit                                 Blooming
     ──────                                 ────────
     'step' event      ──translate──►       onText(content)

     'tool_call_start' ──translate──►       onToolCall(toolCall)  ← NEW ToolCall
                        + stash by name

     'tool_call_end'   ──match stash──►     onToolResult(toolCall) ← same ToolCall,
                        + fill duration                              enriched
                        + fill result

     ALL events        ──pass through──►    onCapabilityEvent(event)  ← additive,
                                                                        optional
```

The **stash-and-match** in `emit` (`lib/agents/aptkit-adapters.ts:168-183`) is the interesting part. AptKit emits `tool_call_start` and `tool_call_end` as separate events; Blooming's UI wants a *single* `ToolCall` object that starts with `{ toolName, args }` and gets enriched later with `{ durationMs, result, error }`. The adapter holds a `Map<toolName, ToolCall[]>` between events so the end event can find the matching start and fill in the missing fields.

The `onCapabilityEvent` hook (`lib/agents/aptkit-adapters.ts:161`) is additive and Phase-2. Callers that don't set it see identical behavior. When set — as the eval runner does — it forwards every raw event to a consumer that can feed the trace into `summarizeUsage` + `estimateCost` for per-invocation token + cost receipts. This is what makes the eval harness's cost math work (`06-budget-and-observability.md` picks this thread up).

**Move 2 variant — the skeleton.** Three ports, three adapters, one thin composition site (the agent classes: `MonitoringAgent`, `DiagnosticAgent`, etc.). What breaks when each is missing:

- **No `ModelProvider` port** → the Anthropic client leaks into AptKit; swapping models means editing AptKit.
- **No `ToolRegistry` port** → the DataSource seam leaks into AptKit; swapping data sources means editing AptKit.
- **No `CapabilityTraceSink` port** → observability leaks into AptKit; the UI's trace shape leaks up through AptKit into every agent class.

Optional hardening: the budget tracker (composed *into* `AnthropicModelProviderAdapter`, doesn't change the port); the prompt-cache wrapping (also inside the adapter); the additive `onCapabilityEvent` forwarding (doesn't change the trace-sink port; just fires one more callback in the adapter).

### Move 2.5 — legacy state

The `-legacy.ts` files (`lib/agents/base-legacy.ts`, `diagnostic-legacy.ts`, `monitoring-legacy.ts`, etc.) are pre-AptKit implementations kept in-tree during the migration. Today they're dead code shipping in the deploy bundle. The migration is over — the AptKit adapters are what runs, per every route handler import. The legacy files are queued for removal after the baseline eval confirms the AptKit path leads on every rubric dimension by ≥5pp.

### Move 3 — the principle

**The port is owned by whoever needs to evolve independently.** When Blooming owned the port (`DataSource` in `01-`), Blooming got to swap adapters without touching callers. Here, AptKit owns the ports, so AptKit gets to evolve the agent primitives — add a new `CapabilityEvent` type, change the `ModelRequest` shape — and Blooming has to update the three adapters to keep up. That's the tradeoff of using someone else's port: their internal changes become your migration surface.

The corollary: **the boundary is the migration surface.** When AptKit ships 0.4.x, all the shape changes will land in the three adapter classes. Route handlers, agent wrappers, UI code all stay untouched. That's why the bridge sits in one file — 260 LOC in `lib/agents/aptkit-adapters.ts` is the entire cost of tracking the runtime.

## Primary diagram

```
  The full AptKit boundary — three ports, three adapters, one file

  ┌─ Blooming ────────────────────────────────────────────────────────┐
  │                                                                    │
  │  MonitoringAgent / DiagnosticAgent / RecommendationAgent            │
  │      │                                                              │
  │      │ constructs each of the three adapters                        │
  │      │ passes them into the matching @aptkit/core agent class       │
  │      ▼                                                              │
  │   ┌──────────────────────────┐  ┌────────────────────────────┐    │
  │   │AnthropicModelProvider    │  │BloomingToolRegistryAdapter │    │
  │   │Adapter                    │  │                             │    │
  │   │  implements ModelProvider │  │  implements ToolRegistry   │    │
  │   │  wraps Anthropic SDK      │  │  wraps DataSource + tools  │    │
  │   │  + prompt cache breakpoint│  │  + drops the fromCache flag│    │
  │   │  + budget ceiling gate    │  │                             │    │
  │   │  + usage accumulation     │  │                             │    │
  │   └──────────────────────────┘  └────────────────────────────┘    │
  │   ┌──────────────────────────┐                                     │
  │   │BloomingTraceSinkAdapter  │                                     │
  │   │  implements CapabilityTraceSink                                │
  │   │  routes 'step' → onText                                        │
  │   │  routes 'tool_call_start' → onToolCall (via stash-and-match)   │
  │   │  routes 'tool_call_end'   → onToolResult                       │
  │   │  forwards ALL → onCapabilityEvent (additive Phase-2)           │
  │   └──────────────────────────┘                                     │
  └────────────────────────────┬───────────────────────────────────────┘
                               │  passed via constructor injection
                               ▼
  ┌─ @aptkit/core ──────────────────────────────────────────────────────┐
  │                                                                     │
  │  AnomalyMonitoringAgent · DiagnosticInvestigationAgent · ...         │
  │    calls model.complete(request)                                     │
  │    calls tools.callTool(name, args)                                  │
  │    calls trace.emit(event)                                           │
  │                                                                     │
  │  primitives:  ModelProvider · ToolRegistry · CapabilityTraceSink     │
  │  (interfaces; Blooming supplies the concrete classes)                │
  └─────────────────────────────────────────────────────────────────────┘

  three ports, three adapters, one bridge file (260 LOC)
```

## Elaborate

The AptKit boundary is what makes the DataSource seam useful *twice*. Once at the caller-of-tools altitude (route handler → `DataSource`) and again at the runtime-of-agents altitude (`@aptkit/core` → `ToolRegistry`). The two seams stack. If Blooming ever swaps out `@aptkit/core` for a different agent runtime, the DataSource seam survives — because it's below the AptKit boundary, not entangled with it.

The general principle at work here — sometimes called *stable dependencies* — is that packages should depend on things more stable than themselves. `@aptkit/core` is more stable than Blooming's app (it's a shared library used by other projects; changing it costs more). So Blooming depends on it, not the other way around. AptKit doesn't depend on Anthropic, Bloomreach, or Blooming's UI; those are all less stable. The adapters *bridge* Blooming's less-stable code to AptKit's more-stable interfaces.

The 260-LOC file is worth understanding structurally: three classes, no shared state, each independently testable. If one of the three adapters breaks — e.g., AptKit adds a new `CapabilityEvent` variant — only `BloomingTraceSinkAdapter.emit`'s switch statement needs to grow. The other two adapters don't touch. That's the payoff of splitting the ports along orthogonal axes.

What to read next:
- `01-datasource-seam.md` — the neighbor bridge Blooming controls the port for; note the direction inversion.
- `06-budget-and-observability.md` — where the `BudgetTracker` and `onCapabilityEvent` cross-cutting concerns get threaded through this boundary.
- `study-agent-architecture` — the mechanism *inside* AptKit's agent classes (ReAct loop, tool-use turn structure); this file only covers the *boundary* to that runtime.

## Interview defense

**Q: "You've got three separate adapter classes for one boundary. Why split them?"**

A: Each port varies independently. The model can swap (Anthropic → OpenAI → Vertex) without touching tools or tracing. The tools can swap (already do — that's the whole DataSource seam) without touching the model. The trace-sink varies per call site (the route handler wants NDJSON emission; the eval harness wants raw event forwarding; the load runner wants ledger accumulation). If I collapsed the three into one giant "AptKitAdapter" class, every one of those independent axes would force a change to a shared class. Three axes of variation, three classes.

```
   model axis        ─►   AnthropicModelProviderAdapter   only
   tools axis        ─►   BloomingToolRegistryAdapter     only
   trace axis        ─►   BloomingTraceSinkAdapter        only

   → orthogonal ports, orthogonal changes
```

*Load-bearing part people forget:* the ports live in `@aptkit/core`, not in Blooming. That directionality is the whole reason evolution is asymmetric — AptKit's changes are Blooming's migration surface, but Blooming's changes are entirely local to the three adapters. If Blooming owned the ports, this would be reversed.

**Q: "What runs in this adapter that AptKit doesn't know about?"**

A: Three things live inside `AnthropicModelProviderAdapter` that AptKit is entirely blind to:

1. **Prompt caching** — the system prompt is wrapped with `cache_control: { type: 'ephemeral' }` on every dispatch. AptKit doesn't have a "cache this prefix" concept; the adapter just does it. Result: ~80% reduction on system-prompt token cost for a ~10-turn investigation.
2. **The budget-ceiling gate** — before every `messages.create` call, the adapter checks a `BudgetTracker` and throws `BudgetExceededError` if the accumulated spend has passed the ceiling. AptKit's ReAct loop just sees the throw and unwinds cleanly.
3. **Usage accumulation** — after every response, the adapter feeds `input_tokens + output_tokens` back to the tracker. Uses raw counts (not cache-read tokens, which AptKit's `model_usage` event doesn't surface), so it's slightly conservative under caching.

The pattern: cross-cutting concerns that AptKit shouldn't know about live in the adapter, not in the port. If they lived in the port, every project using AptKit would have to implement them.

```
   AptKit sees:  ModelRequest → ModelResponse

   adapter runs:  budget.exceeded? → cache-wrap system prompt →
                  Anthropic call →
                  budget.add(usage) → ModelResponse
```

*Load-bearing part people forget:* the budget check is *before* the dispatch, not after. Checking after would let a runaway loop burn one more turn's cost after the ceiling was already hit; checking before means the next turn simply doesn't fire.

**Q: "The trace-sink adapter stashes tool_call_start and matches it on tool_call_end. Why bother?"**

A: AptKit emits start and end as two separate events. Blooming's UI wants one `ToolCall` object that starts with `{ toolName, args }` and gets enriched later with `{ durationMs, result, error }`. Without the stash, the adapter would emit two separate `ToolCall` objects and the UI would have to reconcile them itself — which means every consumer of `onToolCall`/`onToolResult` would need to know about the split. The stash keeps the translation local: AptKit gets its two-event model; Blooming's callers get the one-object model.

The `Map<toolName, ToolCall[]>` is scoped to *the adapter instance*, which lives for one agent invocation. A single tool called twice (which happens in a ReAct loop) fires two starts and two ends; the array pops FIFO so end-events match start-events in order.

*Load-bearing part people forget:* this is a per-invocation adapter, not a singleton. If the same adapter were shared across concurrent invocations, the stash would cross-contaminate. Each `DiagnosticAgent.investigate` constructs a fresh adapter.

## See also

- `01-datasource-seam.md` — the sister bridge, below this one, that this boundary uses through `BloomingToolRegistryAdapter`.
- `06-budget-and-observability.md` — how the cross-cutting hooks flow through this boundary.
- `07-eval-regression-gate.md` — the primary consumer of the `onCapabilityEvent` hook.

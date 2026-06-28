# RFC 06 — AptKit primitives + Blooming adapter boundary

**Decision:** Migrate from the hand-rolled `runAgentLoop` to
**`@aptkit/core@0.3.0`** as the agent-loop runtime. Keep three Blooming-owned
**adapter classes** at `lib/agents/aptkit-adapters.ts` (206 LOC) as the
boundary between Blooming's vendor-specific surface (Anthropic SDK,
DataSource, agent-trace hooks) and AptKit's provider-neutral primitives
(`ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`). The legacy
hand-rolled loop is preserved at `lib/agents/base-legacy.ts` (270 LOC) as
the rollback receipt.

## Context

Blooming started with a hand-rolled tool-use loop in
`lib/agents/base.ts` — `runAgentLoop`. The hand-roll was deliberate, not
naive: it needed two things off-the-shelf libraries at the time didn't
provide cleanly.

  1. **A `maxToolCalls` budget.** A model that loops on tool calls against
     a rate-limited server (~1 req/s) burns the entire route budget if
     unbounded. Need a hard ceiling.
  2. **A forced synthesis turn.** After the budget is exhausted (or the
     model voluntarily stops calling tools), force one final turn with
     `tool_choice: 'none'` so the model produces a synthesis instead of
     leaving the user with raw tool output.

Both were operational requirements driven by the Bloomreach alpha server's
behavior, not theoretical concerns. The hand-rolled loop encoded them
directly.

Later, `@aptkit/core` grew the right surface — generic primitives for
`ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`, with a built-in
agent loop that respects budgets and synthesis. The question became: keep
maintaining a 270-LOC hand-rolled loop, or migrate to the library and own a
thin boundary?

The library won.

## Goals

  → **Stop maintaining the agent loop ourselves.** Tool-use loop edge cases
    (parallel tool calls, partial JSON streaming, `tool_choice` interactions)
    are someone else's job now.
  → **Keep Blooming's boundary stable.** Agents (`MonitoringAgent`,
    `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`,
    `classifyIntent`) keep the same constructor + same `scan/diagnose/
    recommend/answer/classify` surface. Route handlers don't change.
  → **Three adapter classes, one per AptKit primitive.** Provider-neutral
    types stay on the library side; vendor-specific types stay on the
    Blooming side. The boundary is the adapters.
  → **Preserve the rollback path.** If the library breaks at version N+1,
    we revert by swapping the import — the legacy loop is checked in,
    tested, and ready.

## Non-goals

  → **Becoming a multi-LLM-vendor product.** AptKit's `ModelProvider` is
    provider-neutral by design (the library targets several backends),
    but Blooming uses Anthropic only. The adapter wraps one vendor.
  → **Letting AptKit own product-shape concerns** (the topology in RFC 03,
    the DataSource in RFC 05, the streaming kernel in RFC 02). AptKit owns
    the loop; Blooming owns the rest of the product.
  → **Contributing to AptKit's surface.** Adapter classes live in Blooming;
    library changes happen upstream.

## The decision

The agent loop moves into the library. Blooming owns three adapter classes
that translate between the two sides. The agents become thin wrappers.

```
  Boundary diagram — what's library, what's Blooming, where the seams are

  ┌─ Blooming (vendor-specific, product-shaped) ─────────────────┐
  │                                                              │
  │  agents/{monitoring,diagnostic,recommendation,query}.ts      │
  │   • take Anthropic + DataSource + WorkspaceSchema            │
  │   • construct the three adapters + an AptKit agent instance  │
  │   • return Blooming-shaped output (Anomaly, Diagnosis, ...)  │
  │                                                              │
  │  agents/intent.ts                                            │
  │   • classifyIntent — single haiku call, no tools (RFC 03)    │
  │                                                              │
  └──────────────┬───────────────────────────────────────────────┘
                 │
                 │  three adapters — the boundary
                 ▼
  ┌─ lib/agents/aptkit-adapters.ts (206 LOC) ────────────────────┐
  │                                                              │
  │  AnthropicModelProviderAdapter  implements ModelProvider     │
  │   • wraps @anthropic-ai/sdk Anthropic                        │
  │   • toAnthropicMessage / toModelContentBlock conversion      │
  │   • logs res.usage at lines 60, 65 for cost tracking         │
  │                                                              │
  │  BloomingToolRegistryAdapter    implements ToolRegistry      │
  │   • wraps DataSource (RFC 05) — McpCaller surface            │
  │   • listTools → ToolDefinition[]                             │
  │   • callTool → { result, durationMs }                        │
  │                                                              │
  │  BloomingTraceSinkAdapter       implements CapabilityTraceSink│
  │   • bridges AptKit CapabilityEvents → Blooming ToolCall hooks│
  │   • activeToolCalls Map for tool_call_start ↔ tool_call_end  │
  │                                                              │
  └──────────────┬───────────────────────────────────────────────┘
                 │
                 │  AptKit-side primitives
                 ▼
  ┌─ @aptkit/core@0.3.0 (provider-neutral, library) ─────────────┐
  │  ModelProvider           ToolRegistry      CapabilityTraceSink│
  │  ModelMessage            ToolDefinition    CapabilityEvent    │
  │  ModelContentBlock       ModelToolResultBlock                 │
  │                                                              │
  │  + the agent loop itself: ReAct-style, with budget +         │
  │    synthesis turn, returning a typed result                  │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Legacy preserved as rollback receipt ───────────────────────┐
  │  lib/agents/base-legacy.ts (270 LOC)                         │
  │   • the hand-rolled runAgentLoop                             │
  │   • monitoring-legacy.ts, diagnostic-legacy.ts, etc.         │
  │   • still passes its tests; one import-swap reverts          │
  └──────────────────────────────────────────────────────────────┘
```

**Verdict-first:** the library owns the loop; Blooming owns the boundary;
the rollback receipt is the legacy folder on disk.

### One question, held constant down the layers

The clean read is **"who owns this code?"** asked at every altitude:

```
  "who owns this code?"

  ┌─────────────────────────────────────┐
  │ outer: MonitoringAgent.scan()       │   → BLOOMING (product surface)
  └─────────────────────────────────────┘
      ┌─────────────────────────────────┐
      │ middle: 3 adapter classes       │   → BLOOMING (boundary)
      └─────────────────────────────────┘
          ┌─────────────────────────────┐
          │ inner: AnomalyMonitoringAgent│  → APTKIT (library)
          │        + ReAct loop          │
          └──────────────────────────────┘
              ┌─────────────────────────┐
              │ innermost: tool call    │  → DATASOURCE (RFC 05)
              └─────────────────────────┘
```

Ownership flips at every seam. That's the test the boundary passes.

### The three adapters — what each one is for

#### `AnthropicModelProviderAdapter` — vendor → library

Converts AptKit's `ModelRequest` (provider-neutral) into an Anthropic
`MessageCreateParams`, calls the SDK, converts the response back. Logs
`res.usage` for cost tracking at lines 60-61, 65-67:

```ts
// lib/agents/aptkit-adapters.ts:57-71
const response = await this.anthropic.messages.create(params, ...);

console.log(JSON.stringify({
  site: this.logSite,
  sessionId: this.sessionId,
  usage: response.usage,
}));

return {
  content: response.content.flatMap(toModelContentBlock),
  usage: {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  },
  model: response.model,
};
```

The `res.usage` log is the load-bearing observability part. AptKit doesn't
log it; Blooming needs it to track briefing cost.

#### `BloomingToolRegistryAdapter` — DataSource → library

Wraps the `DataSource` from RFC 05. Translates `listTools` results into
AptKit `ToolDefinition[]`; translates `callTool` results into
`{ result, durationMs }`. The DataSource envelope's `fromCache` field is
dropped at the boundary because AptKit doesn't model caching; the trace
sink picks it up separately if needed.

#### `BloomingTraceSinkAdapter` — library events → Blooming hooks

AptKit emits `CapabilityEvent`s (`step` for text, `tool_call_start`,
`tool_call_end`). Blooming's UI consumes `ToolCall` objects with an
`id`/`agent`/`toolName`/`args`/`durationMs`/`result`/`error` shape, fed
through `hooks.onToolCall` / `hooks.onToolResult`. The adapter bridges
both with a `Map<toolName, ToolCall[]>` queue to pair starts with ends:

```ts
// lib/agents/aptkit-adapters.ts:108-130
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

The `activeToolCalls` Map is load-bearing for parallel tool calls — without
the queue, two simultaneous calls of the same tool would conflate their
results. The fallback `?? this.toBloomingToolCall(event)` covers the edge
case where AptKit emits an end with no matching start (shouldn't happen
in practice; defensive).

### The agents become thin wrappers

`MonitoringAgent.scan()` (`lib/agents/monitoring.ts:82-93`) is now:

```ts
async scan(hooks?: MonitorHooks, categories: AnomalyCategory[] = []) {
  const toolRegistry = new BloomingToolRegistryAdapter(this.dataSource, this.allTools);
  const agent = new AptKitAnomalyMonitoringAgent({
    model: new AnthropicModelProviderAdapter(this.anthropic, 'monitoring', this.sessionId),
    tools: toolRegistry,
    workspace: this.schema,
    trace: new BloomingTraceSinkAdapter(hooks ?? {}, 'monitoring'),
    categories: ...,
  });
  return (await agent.scan({ signal: hooks?.signal })).map(toBloomingAnomaly);
}
```

Three adapter constructions + one library call + one result mapping. The
agent class earns its weight by:
  → encapsulating the adapter wiring per agent kind
  → owning the Blooming-shaped output (the `toBloomingAnomaly` mapper)
  → threading `signal` from the route layer's `req.signal` down into the
    AptKit loop (preserves the route-level cancellation contract)

## Alternatives considered

### Alternative A — Keep the hand-rolled `runAgentLoop`

Stay on `base-legacy.ts`. Maintain it ourselves.

**Why it lost:** Three things.

  1. **Maintenance cost grows with model evolution.** Anthropic's tool-use
     surface evolves; partial JSON streaming, parallel tool calls, new
     `tool_choice` options. Tracking those in a hand-rolled loop is real
     work for marginal value.
  2. **AptKit's ReAct loop is more complete than ours was.** It handles
     edge cases the hand-roll punted on (proper handling of multiple
     `tool_use` blocks in one assistant message, defensive parsing of
     malformed tool inputs).
  3. **The adapter cost is low.** 206 LOC of adapter code replaces 270 LOC
     of loop code, plus all the per-agent loop wiring that lived in
     `monitoring-legacy.ts` etc. Net code reduction, more capability.

The hand-roll was the right call at the time it shipped. AptKit's
generic-primitive surface only existed once it did. The migration was
correct *once the library caught up*.

### Alternative B — Use Anthropic SDK's built-in tool-use helpers directly

Skip the abstraction. Call `anthropic.messages.create` in a loop directly
in each agent.

**Why it lost:** This is what the hand-rolled loop already was. Calling it
"the SDK's helper" vs. "our loop" doesn't change anything. The win of the
adapter approach is that the loop logic isn't in our code at all.

### Alternative C — Couple to AptKit's vendor classes directly (skip the adapters)

Use AptKit's own Anthropic provider, its own MCP tool registry, its own
trace shape. Strip the adapters.

**Why it lost:** Two real reasons.

  1. **AptKit's surfaces are intentionally generic.** Its
     `ModelProvider` could wrap any vendor; tying Blooming's
     vendor-specific concerns (the `res.usage` log site, the
     `claude-sonnet-4-6` model id, the per-agent log naming) into the
     library would push product knowledge upstream. Wrong direction.
  2. **The adapter is the rollback receipt.** If AptKit's API changes at
     version N+1, the change lands in the adapter — not in five agents.
     A future migration off AptKit lands in the adapter too.

### Alternative D — Wait until AptKit grows the exact shape we need

Don't migrate yet; keep the hand-roll until the library has 100% of our
features.

**Why it lost:** The library has enough. The bits it doesn't have (per-agent
`logSite` for `res.usage`, Blooming's `ToolCall` shape, the `MonitorHooks`
interface) live cleanly in the adapter layer. Waiting longer would have
been maintenance debt without payoff.

## Tradeoffs accepted

  → **We don't control the loop anymore.** A bug in AptKit's ReAct loop is
    an upstream fix. Mitigated by the legacy folder — one import swap
    reverts to the hand-rolled loop while upstream is patched.
  → **AptKit version bumps need testing.** Today on `0.3.0`. A `0.4.0`
    release could change `ModelProvider`'s interface. CI tests catch type
    breakage; eval suite catches behavior drift.
  → **The adapter layer is duplication.** Every per-agent class
    constructs the same three adapters. A factory (`makeAptKitAgent(...)`)
    would dedupe; deferred until pattern repeats more painfully.
  → **The Blooming-side type maps (`toAnthropicMessage`,
    `toModelContentBlock`, etc.) at lines 144-202 are mechanical.** They
    are correct, tested, and a little tedious. The tedium is the cost of
    keeping vendor types out of the library.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| AptKit's ReAct loop regresses (e.g. drops the synthesis turn) | Eval suite (when re-run against Synthetic) catches behavior drift. Legacy folder is the immediate rollback. |
| Anthropic SDK ships a breaking change to `messages.create` | Lands in `AnthropicModelProviderAdapter` only; one file to update. |
| Adapter's `activeToolCalls` Map leaks if AptKit emits `tool_call_start` without `tool_call_end` | Defensive fallback in `emit` (`?? this.toBloomingToolCall(event)`); leak is bounded by AptKit loop's lifetime. Worth a test if it ever materializes. |
| Cost tracking lost if `res.usage` log shape changes | Logs are JSON-stringified at fixed key `usage`. Downstream cost dashboards key on this; change-detect on the field name. |

## Rollout / migration — the receipt

The migration was incremental:

  1. **AptKit `0.3.0` released** with `ModelProvider`, `ToolRegistry`,
     `CapabilityTraceSink` as stable primitives + per-agent classes
     (`AnomalyMonitoringAgent`, etc.) on top.
  2. **Three adapter classes added** in `lib/agents/aptkit-adapters.ts`.
  3. **One agent at a time migrated** — Monitoring, then Diagnostic, then
     Recommendation, then Query, then `classifyIntent` (which is a single
     call, even thinner).
  4. **Each legacy agent preserved** as `*-legacy.ts` (and the loop itself
     as `base-legacy.ts`) — not commented out, not deleted, kept tested.
  5. **Eval suite confirmed behavior equivalence** on the Olist substrate
     before legacy was retired from the hot path.

**Today (after migration):** 5 active agents are thin wrappers; the bridge
is `lib/agents/aptkit-adapters.ts` (206 LOC); the legacy folder is intact;
24 test files / 221 passing. The migration is shipped.

## Open questions

  → **When do we retire the legacy folder?** Today it's the rollback
    receipt — checked in, tested, ready. Retiring it means committing
    fully to AptKit; the cost is a small slice of the repo and the
    psychological cost of "we have a backup."Open — probably retire once
    we've shipped through one AptKit minor version bump without incident.
  → **Should the three adapter constructions be wrapped in a factory?**
    Every per-agent class repeats the construction. A
    `makeAptKitAgent(name, options)` helper would dedupe. Today the
    duplication is tolerable; revisit if a sixth agent kind lands.
  → **AptKit-side `usage` tracking.** Today `res.usage` is logged in the
    adapter on Blooming's side. AptKit might grow first-class usage in the
    trace shape — at which point the adapter's log becomes redundant. Watch
    upstream.
  → **Streaming model output.** Today the adapter uses
    `messages.create` (non-streaming); intermediate text becomes available
    when the model finishes. A streaming adapter would feed partial text
    into `hooks.onText` as it lands. Open — would change UX significantly
    for long synthesis turns.

---

**Coach note:** The line that lands this decision is **"I own the boundary;
AptKit owns the loop."** It re-anchors the listener — they expected either
"we use a library" (loses the product-shape work) or "we built our own"
(loses the leverage). The boundary-vs-loop framing names exactly what's
delegated and what's kept. And the legacy folder is the receipt that the
delegation is reversible — every senior engineer wants to hear a migration
described with the rollback path named.

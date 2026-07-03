# Observability hook

_Project-specific (implements industry-standard trace capture)._

## Zoom out, then zoom in

Every model turn and tool call inside an AptKit agent emits a typed `CapabilityEvent`. Blooming's Week-3A observability hook — `AptKitAgentHooks.onCapabilityEvent` — captures every one before existing per-type routing runs. That gives the eval harness a raw ledger of what the agent did, so `summarizeUsage` + `estimateCost` can build per-invocation cost + token rows without instrumenting the agent code.

```
  Zoom out — where the observability hook sits

  ┌─ AptKit runtime (inside node_modules) ──────────────────────┐
  │  runAgentLoop emits typed CapabilityEvent per moment:       │
  │  step | tool_call_start | tool_call_end | model_usage       │
  └───────────────────────────┬─────────────────────────────────┘
                              │ passed to trace sink
                              ▼
  ┌─ BloomingTraceSinkAdapter.emit ─────────────────────────────┐
  │  1. hooks.onCapabilityEvent?.(event)   ← ★ RAW HOOK ★       │
  │  2. per-type dispatch (step, tool_call_start/end)           │
  └─────────────────┬────────────────────┬──────────────────────┘
                    ▼                    ▼
             route: NDJSON stream    eval: token/cost ledger
             (existing UI path)       (new receipt path)
```

Zoom in: the hook is *additive*. Setting it doesn't change behavior for consumers that don't set it — the per-type dispatch below still runs. That's the load-bearing property: existing code paths are unaffected, new consumers get raw events.

## Structure pass

**Layers:** aptkit emit → BloomingTraceSinkAdapter.emit → onCapabilityEvent hook (raw) + per-type route (existing).
**Axis:** *is this event forwarded verbatim, or dispatched by type?*
**Seam:** the raw-hook fires BEFORE per-type dispatch. Consumers can inspect events the per-type routing would swallow.

```
  The additive-hook shape — old + new, no rewrite

  ┌─ emit(event) ─────────────────────────────────────────┐
  │                                                       │
  │  hooks.onCapabilityEvent?.(event)  ← NEW (additive)   │
  │                                                       │
  │  if (event.type === 'step')       ← OLD (unchanged)   │
  │    hooks.onText?.(event.content);                     │
  │  if (event.type === 'tool_call_start') ...            │
  │  if (event.type === 'tool_call_end') ...              │
  └───────────────────────────────────────────────────────┘

  Existing consumers see the same behavior.
  New consumers (evals) get the raw event stream.
```

## How it works

### Move 1 — the mental model

You've used browser DevTools' Performance recorder — it captures every event, and you filter/aggregate afterward. That's the shape here: capture everything raw, decide what matters at consumption time. The alternative (instrument the agent code with per-metric collectors) is what everyone builds first and then rewrites when the metrics change. The raw-event approach is cheaper to iterate on.

```
  Pattern: raw capture + downstream aggregation

  ┌─ Producer (aptkit) ─────────────┐
  │  emits CapabilityEvent per      │
  │  moment (step, tool_call_*, ...)│
  └────────────┬────────────────────┘
               ▼
  ┌─ Blooming trace sink ───────────┐
  │  onCapabilityEvent?.(event)     │  ← forward raw
  └────────────┬────────────────────┘
               ▼
        ┌──────┴──────┐
        ▼             ▼
  UI stream      eval ledger
  (per-type)     (raw analysis)
```

### Move 2 — the walkthrough

**The hook definition — `lib/agents/aptkit-adapters.ts:20-32`.**

```ts
// aptkit-adapters.ts:20-32 — the additive hook
export type AptKitAgentHooks = {
  onToolCall?: (tc: ToolCall) => void;
  onToolResult?: (tc: ToolCall) => void;
  onText?: (text: string) => void;
  /**
   * Additive Phase-2-observability hook: forwards every raw
   * `CapabilityEvent` from the AptKit trace sink. Optional; when unset,
   * runtime behavior is exactly as before. Consumers use this to feed
   * events into aptkit's `summarizeUsage` + `estimateCost` for
   * per-invocation token + cost ledger rows.
   */
  onCapabilityEvent?: (event: CapabilityEvent) => void;
};
```

Line-by-line:

- **All fields optional.** A consumer sets only what it needs. Existing callers (route.ts) set `onToolCall/onToolResult/onText`; new callers (eval receipts) set `onCapabilityEvent`.
- **`CapabilityEvent` is aptkit's typed event union.** Discriminated by `type` — `'step' | 'tool_call_start' | 'tool_call_end' | 'model_usage' | ...`. Consumers can pattern-match.
- **JSDoc explains the intent.** The comment names the specific downstream (eval ledger via `summarizeUsage` + `estimateCost`), so the next engineer knows what the hook is for.

**The fire site — `lib/agents/aptkit-adapters.ts:157-184`.** The load-bearing single line is at the top of the `emit` method:

```ts
// aptkit-adapters.ts:157-184 — the fire site
emit(event: CapabilityEvent): void {
  // Additive Phase-2 observability: forward every event to the optional
  // capability-event hook before existing per-type routing. Consumers
  // that don't set the hook see identical behavior.
  this.hooks.onCapabilityEvent?.(event);

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

Line-by-line:

- **`this.hooks.onCapabilityEvent?.(event)` fires FIRST.** Every event, unfiltered, before any per-type dispatch runs.
- **Optional-chaining (`?.`).** When the hook is unset (route.ts default), it's a no-op. Zero runtime cost for existing paths.
- **Per-type dispatch continues.** `step` → onText, `tool_call_start` → onToolCall, `tool_call_end` → onToolResult. Same as before Phase 2.
- **Nothing gets swallowed.** `model_usage` events don't have a per-type handler here — but they still reach the raw hook. That's exactly what eval receipts need: they consume `model_usage` for token counts.

**Where the raw stream gets consumed — eval receipts.** The eval runner sets `onCapabilityEvent` to feed events into an aggregator. Each `model_usage` event contains input/output token counts per turn; the aggregator sums them, calls `estimateCost` (Blooming's `estimateAnthropicCost` or aptkit's OpenAI-only helper), and writes a receipt row per investigation. The receipt at `eval/load-receipts/load-2026-07-03T05-21-12-237Z.json` is the output — total tokens, cost, per-investigation percentiles, all derived from the raw event stream.

**Why NOT re-instrument each agent to emit metrics.** The alternative is scattering `metrics.increment(...)` calls throughout the agent code. That's what every "add observability" PR first attempts and then rewrites, because: (a) new metrics require new instrumentation everywhere, (b) the instrumentation code obscures the business logic, (c) tests have to mock the metrics client. The raw-hook approach keeps instrumentation to one line (`hooks.onCapabilityEvent?.(event)`) and lets consumers decide what to aggregate. When a new metric is needed, no agent code changes — just the aggregator.

```
  Layers-and-hops — a model_usage event flows through the hook

  ┌─ AptKit ────────────────────────────────────────────────────┐
  │  after Anthropic response returns:                          │
  │  emit({ type: 'model_usage', inputTokens: 3200,             │
  │         outputTokens: 800, model: 'sonnet-4-6', ... })      │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
  ┌─ BloomingTraceSinkAdapter.emit ─────────────────────────────┐
  │  hooks.onCapabilityEvent?.(event)  ← eval aggregator gets it │
  │  (no per-type handler for 'model_usage' — no-op fallthrough) │
  └─────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ Eval aggregator ───────────────────────────────────────────┐
  │  sums tokens; calls estimateAnthropicCost;                   │
  │  writes receipt row per investigation                        │
  └─────────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

Additive hooks beat scattered instrumentation. One fire site + one type-safe callback lets any downstream (eval receipts, tracing, alerting) consume the raw stream without touching agent code. The property that makes the pattern safe is that unset callbacks are no-ops — existing behavior is unchanged, new behavior is opt-in. The transferable version: when adding observability to a system, add the raw event stream first and aggregate downstream, don't instrument every producer with per-metric calls that you'll rewrite when the metrics change.

## Primary diagram

```
  Recap — the observability hook path

  ┌─ AptKit runAgentLoop ──────────────────────────────────────┐
  │  emits CapabilityEvent per moment:                          │
  │    step             — model reasoning text                  │
  │    tool_call_start  — model requested a tool                │
  │    tool_call_end    — tool returned (result + duration)     │
  │    model_usage      — token counts + model id per turn      │
  └───────────────────────┬────────────────────────────────────┘
                          ▼
  ┌─ BloomingTraceSinkAdapter.emit ────────────────────────────┐
  │  hooks.onCapabilityEvent?.(event)   ← RAW, fires FIRST     │
  │  ─────────────────────────────────                          │
  │  then per-type dispatch (existing paths):                   │
  │    step → hooks.onText                                       │
  │    tool_call_start → hooks.onToolCall                        │
  │    tool_call_end → hooks.onToolResult                        │
  └───┬──────────────────────────┬──────────────────────────────┘
      │                          │
      ▼                          ▼
  ┌────────────────┐      ┌──────────────────────────┐
  │ route.ts       │      │ eval aggregator          │
  │ (NDJSON to UI) │      │ (receipt with tokens+$)  │
  │ uses per-type  │      │ uses onCapabilityEvent   │
  └────────────────┘      └──────────────────────────┘
```

## Elaborate

The Phase-2 observability decision was between two options: (a) instrument each agent with per-metric counters, or (b) add a single raw-event hook to the trace sink. Option (a) is what most teams reach for first and rewrite later — as new metrics are needed, instrumentation spreads across the codebase, tests mock the metrics client, business logic and instrumentation intermix. Option (b) keeps instrumentation to one line and pushes complexity into consumers.

Blooming picked (b) with the additive-hook shape. The trade: consumers have to know the CapabilityEvent shape (they do — aptkit exports the types). The dividend: adding a new metric is a new consumer, not a new instrumentation pass. When the eval receipts needed cache_read tracking, the change was in the eval aggregator, not in agent code.

The `onCapabilityEvent` hook currently drives two things: eval receipts (per-investigation token + cost rows in `eval/load-receipts/`) and the tests that verify AptKit's trace shape hasn't drifted. It could drive more — an alerting webhook on `tool_call_end` with `error !== undefined`, an OpenTelemetry span emitter for distributed traces, a cost dashboard streaming per-turn rows to a metrics backend. None of those exist yet; the hook is the *substrate* they'd land on if adopted.

The reason the hook fires BEFORE per-type dispatch and not after: to preserve time-ordering. If a per-type handler mutates something (e.g., `onToolResult` mutates the tool call by setting `durationMs`), a consumer that fires after would see the mutated state. Firing raw first gives consumers the true event as emitted.

## Interview defense

**Q: How does observability work in this codebase without instrumenting each agent?**
A: One additive hook — `onCapabilityEvent` in `AptKitAgentHooks`. Every model turn and tool call inside AptKit emits a typed `CapabilityEvent`. The trace sink adapter (`BloomingTraceSinkAdapter.emit` in `lib/agents/aptkit-adapters.ts:157-184`) forwards each event to `hooks.onCapabilityEvent?.(event)` *before* running its per-type dispatch. Existing consumers (the route's UI streaming) use the per-type dispatch and see identical behavior. New consumers (eval receipts) set the raw hook and get the whole event stream. When the hook is unset, it's a no-op — zero runtime cost. That's the shape that lets us add observability without touching agent code: one fire site, any number of downstream aggregators.

Diagram: the additive-hook shape with existing per-type and new raw paths.
Anchor: `lib/agents/aptkit-adapters.ts:20-32` (hook def) + `lib/agents/aptkit-adapters.ts:157-184` (fire site).

**Q: Why the raw hook instead of per-metric instrumentation?**
A: Per-metric instrumentation scales linearly with metrics — every new metric is a new call site in the agents. Tests mock the metrics client. Business logic and instrumentation intermix. When we needed cache_read token tracking for eval receipts, the change with the raw hook was a five-line aggregator addition in the eval runner. With scattered instrumentation it would have been a diff across every agent file. The tradeoff: consumers have to know the CapabilityEvent shape — but AptKit exports it, so it's typed. The pattern's transferable name is "raw capture + downstream aggregation," and it's the same instinct as OpenTelemetry spans: emit the event shape, let backends decide what to render.

Diagram: the linear-instrumentation cost curve vs the flat raw-hook curve as metrics grow.
Anchor: `eval/load.eval.ts` (the consumer) + `lib/agents/aptkit-adapters.ts:161` (the fire site).

## See also

- `03-tool-calling-and-mcp.md` — the substrate whose events flow through the hook.
- `05-production-serving/04-cost-controls.md` — the cost math the aggregator runs on captured events.
- `04-guardrails-and-control.md` — BudgetTracker also consumes `model_usage`-equivalent shape (input/output tokens from the SDK response).

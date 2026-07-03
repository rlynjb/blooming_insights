# 04 — Capability-trace fanout

**Adapter-level observability hook fanning raw framework events to
consumers** — Language-agnostic.

## Zoom out — where this concept lives

Between the AptKit primitive and the rest of Blooming sits one adapter
that translates AptKit's `CapabilityEvent` into Blooming's own hook
surface. The additive hook `onCapabilityEvent` gives every consumer
(evals, tests, future observability sinks) a direct feed of the raw
framework event stream — without touching the primitive.

```
  Zoom out — where the trace fanout sits

  ┌─ AptKit primitive (@aptkit/core) ────────────────────────┐
  │  DiagnosticInvestigationAgent · agent loop                │
  │       │  emits CapabilityEvent per step / tool call        │
  │       ▼                                                    │
  │  CapabilityTraceSink.emit(event)                          │
  └──────────────────────┬────────────────────────────────────┘
                         │  (the seam)
  ┌─ Blooming ───────────▼────────────────────────────────────┐
  │  ★ BloomingTraceSinkAdapter ★  ← we are here               │
  │      onCapabilityEvent(ev)          → RAW (evals)          │
  │      onText / onToolCall / onToolResult → typed            │
  │           │                                                │
  │           ▼                                                │
  │      route send() → NDJSON wire → browser                  │
  │      eval receipt.usage[] ← summarizeUsage(trace)          │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in — what it is.** One `emit` method on a class that implements
AptKit's `CapabilityTraceSink` interface. The method fans a single
event three ways: to the raw hook, to the typed hooks, and (via
`activeToolCalls`) to a small piece of correlation state that turns
`tool_call_start` + `tool_call_end` into a matched pair.

## Structure pass

**Layers.** Framework (AptKit) · adapter (`BloomingTraceSinkAdapter`) ·
hook surface (`AptKitAgentHooks`) · consumer (route or eval).

**One axis held constant: control.** Who decides what happens with an
event?

```
  "who decides what to do with each event?"

  ┌───────────────────────────────────────┐
  │ framework: AptKit's agent loop        │   → FRAMEWORK emits
  └───────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ adapter: BloomingTraceSinkAdapter   │   → ADAPTER dispatches
      └─────────────────────────────────────┘
          ┌────────────────────────────────┐
          │ hooks: onCapabilityEvent / ...  │   → CONSUMER handles
          └────────────────────────────────┘

  the adapter never DECIDES what an event means —
  it only routes it. every consumer picks its own shape.
```

**Seams.** Two:

- **AptKit ↔ Blooming** — `CapabilityTraceSink` interface. AptKit
  emits; Blooming implements. This is a stable contract; the point of
  the adapter is to keep AptKit's shape from leaking into Blooming's
  routes.
- **adapter ↔ consumer** — `AptKitAgentHooks`. Additive by design: a
  consumer that only wants tool events sets `onToolCall` and doesn't
  need to know a raw hook exists. A consumer that wants raw sets
  `onCapabilityEvent` and doesn't need to know the typed ones exist.
  Zero required fields.

## How it works

### Move 1 — the mental model

You know how a middleware layer in Express calls `next()` to pass a
request through the chain? Same shape here, but the "chain" is
parallel — every hook fires on the same event. The `emit` method is
the fanout point. Set two hooks and both see the same event; set none
and nothing happens (the primitive still runs, silently). Additive
means: adding a hook never breaks a consumer that didn't set it.

```
  The fanout — one event, multiple listeners

     AptKit CapabilityEvent
             │
             ▼
      ┌── emit(event) ─┐
      │                │
      ├──► onCapabilityEvent(ev)     ← RAW, for evals + summarizeUsage
      │
      ├──► if step:        onText(content)
      ├──► if tool_start:  onToolCall(toBloomingToolCall(ev))
      └──► if tool_end:    onToolResult(toolCall + durationMs + result)

     one event    ────►    up to 4 consumers, each optional
```

### Move 2 — the mechanism, step by step

**Part A — the hook shape.** `AptKitAgentHooks` is the contract with
downstream code. Every field is optional.

Real code from `lib/agents/aptkit-adapters.ts:20-32`:

```ts
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

The `onCapabilityEvent` doc comment names the design intent —
*additive, optional, runtime-identical when unset.* This is the
guarantee that lets the route layer stay untouched while the eval
runner gets richer data.

**Part B — the fanout logic.** `BloomingTraceSinkAdapter.emit` runs
the fanout. The raw hook fires *first*, unconditionally, before any
per-type routing. Then per-type routing runs.

Real code from `lib/agents/aptkit-adapters.ts:149-184`:

```ts
/** Bridges AptKit trace events back into Blooming's existing route/eval hooks. */
export class BloomingTraceSinkAdapter implements CapabilityTraceSink {
  private readonly activeToolCalls = new Map<string, ToolCall[]>();

  constructor(
    private readonly hooks: AptKitAgentHooks,
    private readonly agent: AgentName,
  ) {}

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

Note the order: **raw hook first, then typed routing.** This is
deliberate — an eval consumer that captures every raw event needs
guaranteed delivery, and doing the raw dispatch first means a bug in
the per-type routing (or a `return` inside a branch) can't accidentally
drop a raw event.

**Part C — the correlation state.** `activeToolCalls` is a small
`Map<toolName, ToolCall[]>` that pairs `tool_call_start` with
`tool_call_end`. Without this, the two events are unrelated JSON
blobs; with it, the `durationMs` and `result` from the end event
attach to the same `ToolCall` object the start event created.

The FIFO shape (`push` on start, `shift` on end) handles the case
where the same tool is called twice in a row before either result
arrives — the results attach in call order. This is why the map keys
by `toolName` and the value is an array, not a single object.

**Part D — the consumers.**

Consumer 1 — the route. Sets the typed hooks; feeds them to `send()`:

Real code from `app/api/agent/route.ts:201-215`:

```ts
const hooksFor = (agent: AgentName) => ({
  onText: (t: string) => {
    if (t.trim()) stepFor(agent, 'thought', t);
  },
  onToolCall: (tc: ToolCall) => send({ type: 'tool_call_start', toolName: tc.toolName, agent }),
  onToolResult: (tc: ToolCall) =>
    send({
      type: 'tool_call_end',
      toolName: tc.toolName,
      agent,
      durationMs: tc.durationMs ?? 0,
      result: trunc(tc.result),
      error: tc.error,
    }),
});
```

The route never sets `onCapabilityEvent`. It doesn't need to — the
typed events are richer than the wire needs. The raw hook is unused on
the live path.

Consumer 2 — the eval runner. Sets *both*: `onToolResult` for the
receipt's `diagnosisToolCalls[]`, `onCapabilityEvent` for the
`diagnosisTrace: CapabilityEvent[]` array that gets folded into
`summarizeUsage`.

Real code from `eval/run.eval.ts:207-220`:

```ts
const diagnosisToolCalls: ToolCall[] = [];
const diagnosisTrace: CapabilityEvent[] = [];
const diagnosis = await diagnosticAgent.investigate(goldenCase.anomaly, {
  onToolResult: (tc) => diagnosisToolCalls.push({ ...tc }),
  onCapabilityEvent: (ev) => diagnosisTrace.push(ev),
  budget,
});
const investigateMs = Math.round(performance.now() - t0Investigate);
const diagnosisUsage = summarizeUsage(diagnosisTrace);
// aptkit's estimateCost only knows OpenAI pricing; fall back to
// Blooming's Anthropic pricing helper for our claude-* models.
const diagnosisCost =
  estimateCost('anthropic', diagnosisUsage, 'claude-sonnet-4-6') ??
  estimateAnthropicCost(diagnosisUsage, 'claude-sonnet-4-6');
```

Two collections, two totally different downstream uses. Same event
stream. That's the fanout paying off.

**Part E — the caller entry point.** The agent classes construct the
adapter and pass it to AptKit. This is where the wire-up happens once,
per agent class.

Real code from `lib/agents/diagnostic.ts:46-63`:

```ts
async investigate(anomaly: Anomaly, hooks: AgentHooks = {}): Promise<Diagnosis> {
  const agent = new AptKitDiagnosticInvestigationAgent({
    model: new AnthropicModelProviderAdapter(
      this.anthropic,
      'diagnostic',
      this.sessionId,
      undefined,
      undefined,
      hooks.budget,
    ),
    tools: new BloomingToolRegistryAdapter(this.dataSource, this.allTools),
    workspace: this.schema,
    trace: new BloomingTraceSinkAdapter(hooks, 'diagnostic'),
  });

  return toBloomingDiagnosis(await agent.investigate(anomaly, { signal: hooks.signal }));
}
```

The trace sink is constructed with the caller's hooks. AptKit does the
rest.

### Move 2 variant — the load-bearing skeleton

The kernel:

```
  framework's trace sink interface (CapabilityTraceSink)
  + an adapter that implements it
  + a hooks type with optional fields
  + raw-hook-first dispatch inside the adapter
  + per-type routing after the raw hook
```

- **Drop the raw hook** and evals can't compute `summarizeUsage` — the
  cost math loses its input stream.
- **Drop the "raw first" ordering** and a bug in the per-type routing
  can starve the raw stream. Debugging becomes an ordering exercise.
- **Drop the optional-fields discipline** and every consumer has to set
  every hook. The additive-safety guarantee is gone.
- **Drop the `activeToolCalls` correlation** and consumers get separate
  start / end events with no shared identity — the receipt loses its
  tool-level `durationMs`.

Skeleton vs hardening:

- **Skeleton:** trace-sink interface + adapter + optional hooks +
  raw-first dispatch.
- **Hardening:** the `activeToolCalls` FIFO for correlation; the
  `toBloomingToolCall` fallback for a `tool_call_end` with no matching
  start (e.g. adapter constructed mid-run); the shape translation from
  AptKit's event fields to Blooming's `ToolCall`.

### Move 3 — the principle

**Fan out at the framework seam, not inside the framework.** When you
depend on someone else's agent loop and you want observability, the
temptation is to fork or patch. The adapter pattern says: implement
the framework's contract, and expose your own richer contract on the
other side. Additive hooks make the seam future-proof — new consumers
never break old ones.

## Primary diagram

```
  Capability-trace fanout — full picture

  ┌─ AptKit's DiagnosticInvestigationAgent (loop) ──────────────────┐
  │                                                                  │
  │  step 1: model call         ─► CapabilityEvent { type: 'step' }  │
  │  step 2: tool call start    ─► CapabilityEvent { type: 'tool_    │
  │                                                    call_start' } │
  │  step 3: tool result        ─► CapabilityEvent { type: 'tool_    │
  │                                                    call_end' }   │
  │  step 4: model_usage        ─► CapabilityEvent { type: 'model_   │
  │                                                    usage' }      │
  │  step 5: another step       ─► CapabilityEvent { type: 'step' }  │
  │                                                                  │
  │       │  trace.emit(event)                                       │
  └───────┼──────────────────────────────────────────────────────────┘
          │
          ▼
  ┌─ BloomingTraceSinkAdapter (lib/agents/aptkit-adapters.ts) ──────┐
  │                                                                  │
  │  emit(event) {                                                   │
  │    hooks.onCapabilityEvent?.(event)   ★ RAW HOOK FIRST ★         │
  │                                                                  │
  │    if step: hooks.onText?.(content)                              │
  │    if tool_call_start: {                                         │
  │       toolCall = toBloomingToolCall(event)                       │
  │       activeToolCalls[toolName].push(toolCall)                   │
  │       hooks.onToolCall?.(toolCall)                               │
  │    }                                                             │
  │    if tool_call_end: {                                           │
  │       toolCall = activeToolCalls[toolName].shift() ?? fallback   │
  │       toolCall.durationMs = event.durationMs                     │
  │       toolCall.result = event.result                             │
  │       toolCall.error = event.error                               │
  │       hooks.onToolResult?.(toolCall)                             │
  │    }                                                             │
  │  }                                                               │
  └────────┬────────────────────────┬────────────────────────────────┘
           │                        │
           ▼                        ▼
  ┌─ Route consumer ────┐  ┌─ Eval consumer ─────────────────────────┐
  │                      │  │                                          │
  │  onText → step wire  │  │  onCapabilityEvent → diagnosisTrace[]    │
  │  onToolCall → wire   │  │  onToolResult      → diagnosisToolCalls[]│
  │  onToolResult → wire │  │                                          │
  │                      │  │  Then:                                   │
  │  send(AgentEvent)    │  │    summarizeUsage(diagnosisTrace)        │
  │  → NDJSON → browser  │  │    estimateCost(usage)                   │
  │                      │  │    → receipt.usage.diagnose              │
  └──────────────────────┘  └──────────────────────────────────────────┘
```

## Elaborate

The general pattern — **adapter with additive hooks** — shows up
wherever a system depends on a third-party framework whose event
stream carries more than the caller wants to expose. Winston's
transport interface, log4j's appenders, Sentry's beforeSend hook, and
OpenTelemetry's SDK exporter all have this shape: the framework
produces one canonical stream, the adapter fans it into whatever the
application needs.

The Blooming-specific twist is that the raw hook lands *before* the
typed dispatch. This ordering is what gives the evals a reliable
receipt: `summarizeUsage` needs every `model_usage` event, and the
per-type routing in the adapter doesn't route `model_usage` anywhere.
Without the raw hook, `model_usage` events would be lost. With it,
the evals capture them for free.

The additive-hook discipline (every field optional) is what makes the
Phase-2 observability work land as a *zero-behavior-change* patch to
the route layer. The route sets exactly the hooks it did before; the
eval runner sets more. Nothing in the routes had to change.

Adjacent concepts:

- The AptKit `CapabilityEvent` model — the canonical trace-sink event
  format.
- `summarizeUsage` + `estimateCost` — the consumer of the raw hook
  that turns events into token totals + cost estimates.
- OpenTelemetry SpanProcessor — the same pattern at a lower level:
  processors chain, `onEnd` runs on every span, no processor blocks
  another.

## Interview defense

**Q: What's the load-bearing part of the fanout?**

The raw hook firing *first*, unconditionally, before any per-type
routing. This is what makes `summarizeUsage` reliable — every event
gets to the eval consumer regardless of whether a downstream branch
returned early.

Anchor: `lib/agents/aptkit-adapters.ts:161` — the first line of
`emit()` is `this.hooks.onCapabilityEvent?.(event);`.

**Q: Why is `onCapabilityEvent` optional? Why not always require it?**

Because the route layer doesn't need it — the typed hooks are richer
than the wire needs. Making it required would mean touching the route
handler when the Phase-2 patch went in. Additive-optional means the
route is unchanged and the eval runner gets more data. Zero-behavior-
change is a design goal because the route is production; the eval
runner is not.

**Q: The `activeToolCalls` map — why keyed by toolName instead of an
event id?**

Because AptKit's `tool_call_start` and `tool_call_end` don't share an
id field in the shape Blooming consumes. FIFO by toolName is the
simplest correlation that works: repeated calls to the same tool
match in order. If AptKit ever adds a callId field, the map key would
become `callId` and the array becomes a single value.

Anchor: `lib/agents/aptkit-adapters.ts:168-183`.

**Q: How does this get the token + cost math without a separate model
call?**

The raw event stream includes `model_usage` events. `summarizeUsage`
walks them and folds them into `{ inputTokens, outputTokens, turns }`.
`estimateCost` prices that with Anthropic's per-model rates. Zero
model calls, all offline math from the captured event stream. The
receipts pattern (`02-receipts-as-evidence.md`) then persists the
result.

## See also

- `01-ndjson-agent-event-wire.md` — where the *typed* hooks end up
  going on the live path.
- `02-receipts-as-evidence.md` — where the *raw* hook's captured
  events end up being turned into cost numbers on disk.
- `05-budget-tracker-as-guard.md` — the other observability
  consumer of the model turn, at a different seam.

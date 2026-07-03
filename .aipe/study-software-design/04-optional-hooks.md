# Optional hooks — additive extensibility without breaking callers

Additive-extension pattern · Optional-parameter hook · Language-agnostic

## Zoom out — where this concept lives

You know how a React component can take an optional `onError`
prop and every existing usage still compiles? Same instinct here.
This codebase has added two new cross-cutting concerns —
observability (`onCapabilityEvent`) and budgeting (`budget`) — to
the `AgentHooks` bag without touching a single existing call
site. Every unset consumer sees identical behavior.

```
  Zoom out — where the optional hooks live

  ┌─ Route / eval (caller) ──────────────────────────────┐
  │  const budget = new BudgetTracker({ maxCostUsd: 2 });│
  │  agent.investigate(anomaly, {                         │
  │    onCapabilityEvent: (ev) => trace.push(ev),         │  ← optional
  │    budget,                                             │  ← optional
  │  });                                                   │
  └────────────────────────┬─────────────────────────────┘
                           │  hooks flow down
  ┌─ Agent method ────────▼──────────────────────────────┐
  │  ★ AgentHooks bag ★ — 5 fields, ALL optional          │ ← you are here
  │     onToolCall / onToolResult / onText                │
  │     onCapabilityEvent (new)                           │
  │     budget (new)                                      │
  │     signal (cancellation)                             │
  └────────────────────────┬─────────────────────────────┘
                           │  routed into adapters
  ┌─ aptkit-adapters.ts ───▼─────────────────────────────┐
  │  Trace sink forwards onCapabilityEvent                │
  │  Model provider checks budget.exceeded()              │
  └──────────────────────────────────────────────────────┘
```

The whole shape is: every new concern arrives as an optional
hook, defaults to "do nothing," and adds zero cost when unset.

## Structure pass

**Layers.** Three: caller (route handler or eval), agent method
(diagnostic / recommendation), adapter (trace sink or model
provider).

**Axis: presence.** For each hook, does it fire? Above the agent
method, the caller decides — set or unset. Inside the agent
method, it just forwards. In the adapter, the check `hook?.(...)`
or `budget?.exceeded()` decides at the point of use. The axis
answer flips at the *set/unset* boundary, which is per-caller,
per-invocation.

**Seams.** The `AgentHooks` interface is the seam. Adding a field
here is the only file change needed to add a new cross-cutting
concern. That's the load-bearing property of this shape.

## How it works

### Move 1 — the mental model

**Additive extensibility means: the extension exists as an
optional field, defaults to inert, and the code that dispatches
it uses `?.()` so the unset case is a no-op.** No feature flag,
no config, no separate constructor. Two constraints keep it
honest:

1. The new field is optional in the type.
2. Every consumer uses null-safe invocation (`?.()`, `?.exceeded()`).

```
  Additive-hook pattern — set or unset, zero cost when unset

  caller                    hooks bag             consumer
  ──────                    ─────────             ────────

  hooks = {}          ────► { }              ────► hook?.()  → no-op
                                                    (undefined ignored)

  hooks = {                                         hook?.()  → fires
    onCapabilityEvent ────► { onCE: fn }      ────►  (fn called with ev)
      : fn
  }

  hooks = {
    onCE: fn,                                       hook?.()  → both fire
    budget: t         ────► { onCE: fn,       ────►  budget?.exceeded()
  }                          budget: t }             → tracker consulted
```

The key insight: the consumer doesn't branch on "is the hook
set?" — it just uses optional chaining. That's what makes the
additive shape *cheap*. Every existing call site is unchanged
because unchanged code doesn't set the new fields, so the new
consumer branches see `undefined` and short-circuit.

### Move 2 — the walkthrough

**The hooks bag itself.**

```typescript
// lib/agents/diagnostic.ts:16-35
export interface AgentHooks {
  onToolCall?: (tc: ToolCall) => void;
  onText?: (text: string) => void;
  onToolResult?: (tc: ToolCall) => void;
  /** Additive Phase-2-observability hook. Receives every raw
   *  `CapabilityEvent` from AptKit's trace sink (including model_usage
   *  rows), so callers can feed the trace into `summarizeUsage` +
   *  `estimateCost`. Optional; unset callers see identical behavior. */
  onCapabilityEvent?: (event: import('@aptkit/core').CapabilityEvent) => void;
  /** Phase-3 per-investigation budget tracker. When set, every model turn
   *  in the underlying AptKit agent checks the tracker BEFORE dispatching
   *  and throws `BudgetExceededError` if the ceiling has been hit. The
   *  same tracker can be reused across multiple agent invocations in one
   *  investigation to share the running total. Optional. */
  budget?: import('./budget').BudgetTracker;
  /** Cancellation signal ... Optional — existing callers compile
   *  + pass unchanged. */
  signal?: AbortSignal;
}
```

Annotation:
- Every field is `?:` optional. Not one is required.
- Line 20-24 — the observability hook. JSDoc explicitly says
  "unset callers see identical behavior." That's the property
  the shape guarantees.
- Line 25-30 — the budget hook. Same guarantee — "existing
  callers compile + pass unchanged."
- The order is history-preserved: `onToolCall / onText /
  onToolResult` came first; `onCapabilityEvent` was added in
  Week 3A; `budget` was added in Week 3D. The interface grew by
  two fields with zero call-site changes.

**Consumer 1 — the trace sink forwards observability.**

```typescript
// lib/agents/aptkit-adapters.ts:157-164
emit(event: CapabilityEvent): void {
  // Additive Phase-2 observability: forward every event to the optional
  // capability-event hook before existing per-type routing. Consumers
  // that don't set the hook see identical behavior.
  this.hooks.onCapabilityEvent?.(event);

  if (event.type === 'step') {
    this.hooks.onText?.(event.content);
    return;
  }
  // ... rest of the per-type routing (unchanged)
```

Annotation:
- Line 161 — the optional-chained call. `?.(event)` is the pattern.
  When `onCapabilityEvent` is undefined, the expression short-
  circuits; no error, no runtime cost.
- The comment on line 158-160 restates the guarantee at the point
  of consumption, so a future maintainer editing the trace sink
  can't miss the contract.
- The forwarding happens *before* the per-type routing. That order
  matters — the observability hook sees every raw event; the
  existing hooks (`onText`, `onToolCall`, `onToolResult`) see only
  the derived ones. If the additive hook fired after routing,
  it'd only get the events the old hooks care about.

**Consumer 2 — the model provider checks the budget.**

```typescript
// lib/agents/aptkit-adapters.ts:59-66
async complete(request: ModelRequest): Promise<ModelResponse> {
  // Phase-3 budget-ceiling gate: check BEFORE dispatching the API call
  // so a runaway loop can't burn additional cost after the ceiling has
  // already been hit. Route handler catches this and emits a graceful
  // NDJSON `error` event.
  if (this.budget?.exceeded()) {
    throw new BudgetExceededError(this.budget.snapshot(), this.budget.limit);
  }
  // ...
```

Annotation:
- Line 64 — `this.budget?.exceeded()`. Optional chaining again.
  Unset budget → expression is `undefined` → `if (undefined)` is
  false → no check, no throw. The runaway-loop protection just
  isn't wired.
- The check is *before* the SDK call, so a loop that has already
  overspent can't burn one more turn. That placement is the whole
  point of the pre-check pattern.

**Consumer 3 — the model provider feeds the budget.**

```typescript
// lib/agents/aptkit-adapters.ts:107-110
this.budget?.add({
  inputTokens: response.usage.input_tokens,
  outputTokens: response.usage.output_tokens,
});
```

Annotation: same shape. Unset budget → no accumulation. Every
turn the same tracker is fed, and the same tracker is checked
before the next turn.

**Sharing across agents in one investigation.**

```typescript
// eval/run.eval.ts:207-267 (abridged)
const budget = new BudgetTracker({ maxCostUsd: BUDGET_PER_INVESTIGATION_USD });

const diagnosis = await diagnosticAgent.investigate(anomaly, {
  onToolResult: (tc) => diagnosisToolCalls.push({ ...tc }),
  onCapabilityEvent: (ev) => diagnosisTrace.push(ev),
  budget,                             // ← same instance
});

// ... later, same investigation ...

const recommendations = await recommendationAgent.propose(anomaly, diagnosis, {
  onToolResult: (tc) => recommendationToolCalls.push({ ...tc }),
  onCapabilityEvent: (ev) => recommendationTrace.push(ev),
  budget,                             // ← same instance, accumulated total
});
```

Annotation: the same `BudgetTracker` object is passed to both
agents. The tracker accumulates across them, so by the time the
recommendation agent starts, the running total already includes
the diagnosis's tokens. If the ceiling is $2.00 and diagnosis
already used $1.60, recommendation has $0.40 before it trips.
This is *contract*, not framework wiring — the shared-instance
behavior comes from JavaScript object identity.

The audit called out that this shared-instance contract isn't
visible in the type (see audit lens 7, obviousness). It's true
today: the type says "an optional tracker," and the caller has
to know to share it. The alternative would be a factory function
on the hooks bag, which adds ceremony for zero gain.

**The consumer that didn't need to change — `MonitoringAgent`.**

```typescript
// lib/agents/monitoring.ts:66-72 (unchanged since Week 2)
export interface MonitorHooks {
  onToolCall?: (tc: ToolCall) => void;
  onToolResult?: (tc: ToolCall) => void;
  onText?: (t: string) => void;
  signal?: AbortSignal;
}
```

Annotation: this hooks bag doesn't have `onCapabilityEvent` or
`budget`. It could — and probably should, for consistency (see
audit lens 7 → consistency) — but it doesn't need to. The
monitoring path is called once at the top of the feed page and
doesn't need per-investigation cost gating. Additive means
*optional to add too*, not just optional to consume.

### Move 3 — the principle

**Grow the interface only through additions marked optional.**
Every new field is `?:`, every consumer uses `?.()`, and the
type documents the "unset = no-op" contract in JSDoc. This isn't
a design tradeoff — it's a discipline that produces zero-churn
extension. The alternative (adding required fields or new
methods) forces every existing caller to change, which is
churn that pays no benefit.

The pattern generalizes to any interface that's shared across
many callers and needs to grow. Web-framework middleware options,
React component prop shapes, config objects, telemetry hooks —
they all benefit from the same discipline.

## Primary diagram

```
  Optional-hook additive extensibility — five fields, five short-circuits

  ┌─ Route handler ─────────────────────────────────────────────┐
  │  agent.investigate(anomaly, {                                │
  │    onCapabilityEvent: (ev) => trace.push(ev),   set          │
  │    budget: sharedTracker,                        set          │
  │    signal: req.signal,                           set          │
  │    // onToolCall UNSET                           default no-op│
  │    // onToolResult UNSET                         default no-op│
  │    // onText UNSET                               default no-op│
  │  })                                                          │
  └───────────────────────┬─────────────────────────────────────┘
                          │  hooks: AgentHooks
                          ▼
  ┌─ agent method (diagnostic.investigate) ─────────────────────┐
  │  passes hooks bag to adapters unchanged                      │
  └───────────────────────┬─────────────────────────────────────┘
                          │
                          ▼
  ┌─ trace sink (adapter) ──────────────────────────────────────┐
  │  emit(event):                                                │
  │    hooks.onCapabilityEvent?.(event)  → FIRES  (set)          │
  │    if step:  hooks.onText?.(...)     → no-op (unset)         │
  │    if start: hooks.onToolCall?.(...) → no-op (unset)         │
  │    if end:   hooks.onToolResult?.(...) → no-op (unset)       │
  └─────────────────────────────────────────────────────────────┘

  ┌─ model provider (adapter) ──────────────────────────────────┐
  │  complete(request):                                          │
  │    if (budget?.exceeded()) throw   → CHECK  (set)            │
  │    // ... SDK call ...                                       │
  │    budget?.add({...})              → ACCUM  (set)            │
  │    // signal threaded through fetch                          │
  └─────────────────────────────────────────────────────────────┘

  every unset field shortcuts to no-op. zero-cost when off.
```

## Elaborate

The pattern is often called *null-object pattern* (when the
default is a do-nothing instance instead of `undefined`) or
*optional callback* (in event-driven APIs). The version in
TypeScript is cleanest when the language provides optional
chaining — `?.()` was standardized in ES2020, and it's the
single feature that makes the "unset = no-op" contract syntactic
rather than manual.

Before optional chaining, this shape required boilerplate on
every consumer: `if (hooks.onX) hooks.onX(...)`. Two lines
instead of one. Adding the fifth or sixth hook to a bag became
progressively noisier. Optional chaining collapsed it back to
one line and made the pattern practical for interface bags with
many fields.

Where this repo pushes on the pattern: the *shared-instance*
contract on `budget`. The type says "an optional tracker"; the
runtime property is "one tracker across two agents in one
investigation." That contract lives in caller convention rather
than the type. This is fine — the alternative (a factory or a
mutable ref) adds ceremony without adding safety — but a future
maintainer needs to read the JSDoc to learn it.

## Interview defense

**Q: What's the difference between an optional hook and a
config flag?**
An optional hook receives per-invocation data and returns per-
invocation results (or, for `budget`, accumulates state across
calls). A config flag is set once and read many times. The hook
composes with the caller's execution — the flag doesn't. When
the concern is per-call (observability, budget check on this
turn, this signal for this call), the hook shape fits. When the
concern is global (log level, timeout ceiling), the flag shape
fits.

**Q: Why is `onCapabilityEvent` forwarded *before* the per-type
routing, not after?**
Because the additive hook is meant to see the *raw* aptkit event
stream, including events (like `model_usage`) that the pre-Phase-2
routing didn't have a handler for. If forwarding happened after
the switch, `model_usage` events would be dropped before the new
hook ever saw them, and `summarizeUsage` / `estimateCost` would
be starved of data. The order preserves the guarantee: every
event flows through the additive hook exactly once, no matter
what routing exists downstream.

**Q: What's the load-bearing part people forget?**
The `?:` on the field type. It's easy to add a field and mark it
required-with-a-default-value in the implementation, and then
existing callers won't compile. Marking optional at the *type*
level is what preserves the additive property — TypeScript will
accept every existing call site because the field is genuinely
allowed to be absent.

The second load-bearing part: the JSDoc line that says "unset
callers see identical behavior." Without that comment, a future
maintainer might add a `if (!hooks.onCapabilityEvent) throw`
check somewhere and break the guarantee silently. The comment
codifies the contract into the code so it survives changes.

**Q: What would you do differently?**
Fold `MonitorHooks` into `AgentHooks`. Two shapes for the same
job is a red flag (audit lens 7), and the monitoring path
would benefit from the same observability hook so its trace can
feed the same `summarizeUsage` pipeline. Rename the merged type
to `InvestigationHooks` since it's now shared.

## See also

- `02-aptkit-bridge.md` — the adapter bundle where the hooks are
  consumed.
- `05-fallback-chain.md` — same additive-composition instinct
  applied to a return value instead of an interface.
- `.aipe/read-aposd/` — the book chapter on modules and
  interfaces (deep modules, hiding).

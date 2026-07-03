# 05 — Budget tracker as guard

**Per-invocation cost ceiling with pre-emptive circuit-break** —
Language-agnostic.

## Zoom out — where this concept lives

Between the agent classes and the Anthropic API sits a `BudgetTracker`
that watches the running token / cost total. Every model turn checks
the tracker BEFORE dispatching; a breach throws
`BudgetExceededError` which propagates up to the route's error path
and lands on the wire as a graceful `error` event. Observability +
guard rolled into one primitive.

```
  Zoom out — where the guard sits

  ┌─ Route handler ──────────────────────────────────────────┐
  │  budget = new BudgetTracker({ maxCostUsd: 2.0 })          │
  │  diagAgent.investigate(anomaly, { hooks, budget })        │
  │  recAgent.propose(anomaly, dx, { hooks, budget })         │
  │  ────────────────────────────────────────                 │
  │  same tracker → shared running total                      │
  └────────────────────────┬─────────────────────────────────┘
                           │
  ┌─ AnthropicModelProviderAdapter ─▼──────────────────────┐
  │  complete(request) {                                    │
  │    ★ if (budget?.exceeded()) throw BudgetExceededError │
  │    ...actual Anthropic API call...                      │
  │    budget?.add({ inputTokens, outputTokens })           │
  │  }                                                      │
  └────────────────────┬───────────────────────────────────┘
                       │
                       ▼
                 Anthropic API
```

**Zoom in — what it is.** A tiny class (~60 LoC) that accumulates
`{ inputTokens, outputTokens, turns }` and computes cost via Blooming's
pricing helper. Two methods: `add(usage)` after each response,
`exceeded()` before the next call.

## Structure pass

**Layers.** Route (constructs the tracker) · agent adapter (checks +
feeds it) · pricing helper (turns tokens → dollars) · error path (turns
breach → wire event).

**One axis held constant: cost — where does the running total live?**

```
  "where does the running cost total live?"

  ┌───────────────────────────────────────┐
  │ route: BudgetTracker instance          │   → HOLDS the state
  └───────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ adapter: reads exceeded(), calls add│   → READS + WRITES
      └─────────────────────────────────────┘
          ┌────────────────────────────────┐
          │ pricing: stateless per-model rate│  → COMPUTES only
          └────────────────────────────────┘

  the tracker OWNS the state; every other layer is a pure function
  over it. hand a tracker to N agents and they share the ceiling.
```

**Seams.** The `AgentHooks.budget?: BudgetTracker` optional field
(`lib/agents/diagnostic.ts:16-35`) is the sharing seam. Pass the same
tracker to two agents and the ceiling counts the sum. Pass no tracker
and the check is a no-op.

## How it works

### Move 1 — the mental model

You know how a `for` loop that has a runaway condition (`while (true)`
with a missing `break`) burns CPU until you kill the process? An LLM
agent loop that hallucinates a never-ending tool call plan does the
same thing — but with real dollars per iteration instead of just CPU.
The budget tracker is the `if (i >= LIMIT) break` you add to protect
yourself. The catch: you check BEFORE the next model call, not after,
so you don't first pay for the call that put you over.

```
  The guard — check-before-call, not check-after

     agent loop iteration:

     ┌──────────────────────────┐
     │  if (budget.exceeded())  │  ← CHECK FIRST
     │     throw BudgetExceededError
     └──────────────┬───────────┘
                    │  no
                    ▼
     ┌──────────────────────────┐
     │  await anthropic.call()  │  ← spend money
     └──────────────┬───────────┘
                    │
                    ▼
     ┌──────────────────────────┐
     │  budget.add(response.usage) │  ← record spend
     └──────────────────────────┘

     loop again
```

### Move 2 — the mechanism, step by step

**Part A — the tracker.** Two counters, a turn count, one snapshot,
one predicate. ~60 lines total.

Real code from `lib/agents/budget.ts:41-77`:

```ts
/**
 * Accumulates token usage across all model turns within one investigation.
 * Read-only from the model provider's perspective — the adapter calls
 * `add()` after each response and `exceeded()` before the next call.
 */
export class BudgetTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private turns = 0;

  constructor(
    public readonly limit: BudgetLimit,
    private readonly modelName: string = 'claude-sonnet-4-6',
  ) {}

  add(usage: { inputTokens: number; outputTokens: number }): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.turns += 1;
  }

  snapshot(): BudgetSnapshot {
    const est = estimateAnthropicCost(
      { inputTokens: this.inputTokens, outputTokens: this.outputTokens },
      this.modelName,
    );
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      turns: this.turns,
      estimatedCostUsd: est?.totalCost ?? 0,
    };
  }

  exceeded(): boolean {
    const s = this.snapshot();
    if (this.limit.maxTokens != null && s.totalTokens > this.limit.maxTokens) return true;
    if (this.limit.maxCostUsd != null && s.estimatedCostUsd > this.limit.maxCostUsd) return true;
    return false;
  }
}
```

Two kinds of ceiling — `maxTokens` and `maxCostUsd`. `exceeded()` is a
short-circuit OR; hitting either one breaches. Setting neither means
unlimited (the check falls through both `if`s and returns false).

The comment names one honest limitation:
`Cache math uses Blooming's pricing helper — same numbers as the
report.` The tracker is slightly conservative when caching is on
because aptkit's `model_usage` event doesn't expose cache tokens (see
red-flag R4 in `audit.md`), so the tracker undercounts the discount.

**Part B — the check.** The adapter checks `exceeded()` *before* the
Anthropic API call.

Real code from `lib/agents/aptkit-adapters.ts:59-70`:

```ts
async complete(request: ModelRequest): Promise<ModelResponse> {
  // Phase-3 budget-ceiling gate: check BEFORE dispatching the API call
  // so a runaway loop can't burn additional cost after the ceiling has
  // already been hit. Route handler catches this and emits a graceful
  // NDJSON `error` event.
  if (this.budget?.exceeded()) {
    throw new BudgetExceededError(this.budget.snapshot(), this.budget.limit);
  }

  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: this.defaultModel,
    max_tokens: request.maxTokens ?? 4096,
    messages: request.messages.map(toAnthropicMessage),
  };
```

The `?.` on `this.budget?.exceeded()` is important: if the caller
didn't pass a budget (the whole feature is optional), the check
degrades to a no-op. Existing callers see zero behavior change; new
callers who opt in get the guard.

**Part C — the record.** After the API call succeeds, the adapter
feeds the response usage back into the tracker.

Real code from `lib/agents/aptkit-adapters.ts:97-110`:

```ts
console.log(JSON.stringify({
  site: this.logSite,
  sessionId: this.sessionId,
  usage: response.usage,
}));

// Phase-3 budget accumulation. Uses inputTokens (not cache_read tokens
// — those aren't exposed by aptkit's model_usage event) so the tracker
// is slightly conservative when caching is on: it undercounts the
// cache-read fraction.
this.budget?.add({
  inputTokens: response.usage.input_tokens,
  outputTokens: response.usage.output_tokens,
});
```

Both the per-turn log and the tracker update happen unconditionally
after every successful call. The log line is what tells you (via
Vercel) that a specific turn happened; the tracker update is what
tells the *next* turn's `exceeded()` check that spending happened.

**Part D — the error.** `BudgetExceededError` is a named subclass so
callers can special-case it if they want. Today no one does — the
route's generic error path handles it.

Real code from `lib/agents/budget.ts:85-95`:

```ts
export class BudgetExceededError extends Error {
  constructor(
    public readonly snapshot: BudgetSnapshot,
    public readonly limit: BudgetLimit,
  ) {
    super(
      `Investigation budget exceeded: ${snapshot.totalTokens} tokens / $${snapshot.estimatedCostUsd.toFixed(3)} vs limit ${limitToString(limit)}`,
    );
    this.name = 'BudgetExceededError';
  }
}
```

The error message includes the snapshot AND the limit — someone
reading a Vercel log sees exactly what was spent, and what the cap
was, in one string.

**Part E — sharing across agents.** The tracker is constructed once
per investigation and passed to both `DiagnosticAgent` and
`RecommendationAgent` in the eval runner. This is the key design
choice: the ceiling is *per investigation*, not per agent.

Real code from `eval/run.eval.ts:194-214`:

```ts
// Per-investigation budget tracker. Shared across DiagnosticAgent
// + RecommendationAgent so the ceiling counts total spend, not
// per-agent spend. Limit sourced from BUDGET_MAX_USD env var
// (default 2.00 USD — very generous vs the observed ~$0.09/case,
// this is here as an escape valve, not a normal-path constraint).
const budgetLimitUsd = Number(process.env.BUDGET_MAX_USD ?? '2.0');
const budget = new BudgetTracker({ maxCostUsd: budgetLimitUsd });
let budgetError: string | undefined;

// ─── diagnose ─────────────────────────────────────────────────────
const t0Investigate = performance.now();
const diagnosticAgent = new DiagnosticAgent(/*...*/);
const diagnosisToolCalls: ToolCall[] = [];
const diagnosisTrace: CapabilityEvent[] = [];
const diagnosis = await diagnosticAgent.investigate(goldenCase.anomaly, {
  onToolResult: (tc) => diagnosisToolCalls.push({ ...tc }),
  onCapabilityEvent: (ev) => diagnosisTrace.push(ev),
  budget,  // ← shared instance
});
```

Then later, the same `budget` is passed to
`recommendationAgent.propose`. Same tracker, running total accumulates
across both.

### Move 2 variant — the load-bearing skeleton

The kernel:

```
  accumulator (input + output tokens + turns)
  + limit (max tokens OR max cost OR both)
  + snapshot (accumulator → dollars via pricing helper)
  + exceeded() predicate (short-circuit OR of limits)
  + CHECK-BEFORE-CALL discipline in the model adapter
  + record-after-call to accumulate
```

- **Drop check-before-call** and you pay for the call that puts you
  over. Runaway loop still gets one more model turn every iteration
  before the guard fires — worse than useless if the loop is
  self-sustaining.
- **Drop the shared instance** and each agent's ceiling is
  independent; a diagnosis burning 90% of the total budget lets
  recommendation burn its own full budget on top.
- **Drop the named error class** and the route can't distinguish
  budget breach from other errors — the wire event says "some error
  occurred" instead of "budget exceeded at 2500 tokens / $0.045."
- **Drop the pricing helper** and the ceiling is only tokens; you
  can't cap "spend more than $X" — which is what a business actually
  wants to cap.

Skeleton vs hardening:

- **Skeleton:** counters + limit + `add` + `exceeded` + check-before-
  call.
- **Hardening:** the optional field (zero behavior change when unset);
  the snapshot in the error (audit trail); the receipt includes the
  full snapshot even when the ceiling wasn't hit (proves the guard
  was live); sharing across agents (per-investigation semantics).

### Move 3 — the principle

**Instrument at the seam that spends money.** Every model call goes
through one adapter (`AnthropicModelProviderAdapter.complete`). Put
the guard *there* and every consumer inherits it — the agent
primitive doesn't know it exists. This is the same shape as
rate-limiting middleware, per-request quota accounting, or a
Postgres statement timeout: the primitive is instrumented at the
one gateway, and every use is protected.

## Primary diagram

```
  Budget tracker as guard — full picture

  ┌─ Setup (per investigation) ──────────────────────────────────┐
  │                                                                │
  │  budget = new BudgetTracker({ maxCostUsd: 2.0 })              │
  │      ├─ inputTokens: 0                                        │
  │      ├─ outputTokens: 0                                       │
  │      └─ turns: 0                                              │
  │                                                                │
  └───────────────────────┬────────────────────────────────────────┘
                          │
                          ▼
  ┌─ Model turn loop (AptKit + Anthropic adapter) ───────────────┐
  │                                                                │
  │  ┌─ complete(request) ─────────────────────────────────────┐  │
  │  │                                                          │  │
  │  │  1. GATE (before call)                                   │  │
  │  │     if (budget.exceeded()) {                             │  │
  │  │       snapshot = budget.snapshot()                       │  │
  │  │       throw BudgetExceededError(snapshot, limit)         │  │
  │  │     }                                                    │  │
  │  │                                                          │  │
  │  │  2. CALL Anthropic API                                   │  │
  │  │     response = anthropic.messages.create(params)         │  │
  │  │                                                          │  │
  │  │  3. LOG (per-turn structured log)                        │  │
  │  │     console.log({ site, sessionId, usage })              │  │
  │  │                                                          │  │
  │  │  4. RECORD                                               │  │
  │  │     budget.add({ inputTokens, outputTokens })            │  │
  │  │                                                          │  │
  │  └──────────────────────────────────────────────────────────┘  │
  │                                                                │
  │  ...repeat for every turn in the diagnostic loop...           │
  │                                                                │
  └───────────────────────┬────────────────────────────────────────┘
                          │  (breach happens)
                          ▼
  ┌─ Breach path ─────────────────────────────────────────────────┐
  │                                                                │
  │  throw BudgetExceededError { snapshot, limit }                │
  │      │                                                         │
  │      ▼  bubbles up through AptKit loop                        │
  │  DiagnosticAgent.investigate re-throws                         │
  │      │                                                         │
  │      ▼  falls into route's catch block                        │
  │  send({ type: 'error', message: 'Investigation budget         │
  │                                   exceeded: 2500 tokens /     │
  │                                   $2.010 vs limit $2.000' })  │
  │      │                                                         │
  │      ▼  wire event                                             │
  │  Browser useInvestigation → setError(message)                 │
  │                                                                │
  │  finally block ─► phase log fires with partial phases[]       │
  │                                                                │
  └────────────────────────────────────────────────────────────────┘

  Receipt (eval only):
    budget: {
      limit: { maxCostUsd: 2.0 },
      snapshot: { inputTokens, outputTokens, totalTokens, turns, estimatedCostUsd },
      exceeded: false | true,
      budgetError: undefined | "..." }
```

## Elaborate

The pattern here — **guard at the outermost seam that costs money** —
shows up in every metered-service architecture:

- Postgres has `statement_timeout` — set on the connection, checked by
  the executor at every planning step.
- Cloud provider API SDKs have per-account rate quotas — checked at
  the SDK's request builder before the wire.
- Payment SDKs have per-merchant daily caps — checked at the auth
  step, not at charge time.

The Blooming twist is that the seam is *inside the process*, not at a
network boundary. Every model turn goes through `complete()`; there's
no need for a distributed rate-limiter. The tracker is a plain
in-memory object, checked before dispatch, updated after response.

The design choice that's easy to miss: **the guard is per invocation,
not per agent.** A diagnostic that eats 90% of the budget lets the
recommendation phase see a nearly-exceeded tracker on its first
call — and it may throw on turn 1. That's the correct semantics for
"one investigation shouldn't burn more than $X total," but it does
mean recommendation quality can suffer if diagnostic is expensive.
The `budgetError` field in the receipt records this so it's visible
in eval retrospectives.

Adjacent concepts:

- **Token bucket rate limiters** — same shape, different accumulator
  (rate instead of total).
- **Circuit breakers** — same "check before proceed" pattern, keyed
  on error rate instead of cost.
- **AptKit's own retry/backoff** — bounds retries, not cost. The
  budget is the second layer that catches "retry succeeded but the
  loop is looping forever."

## Interview defense

**Q: Why check `exceeded()` *before* the call, not after?**

Because after-the-call means you pay for the call that put you over.
For a loop that's hallucinating turn after turn, that's one extra turn
per breach — cost you can't get back. The pre-emptive check turns the
breach into a zero-cost throw at the moment the guard fires.

Anchor: `lib/agents/aptkit-adapters.ts:64` — first thing in
`complete()`, before the params object is even built.

**Q: The tracker is optional — how does that work?**

`AgentHooks.budget?` is optional. When set, the adapter constructor
receives it and uses it. When unset (`this.budget?.exceeded()`), the
`?.` short-circuits to `undefined`, which is falsy — the throw never
fires. Same for `this.budget?.add(...)` — no tracker, no update.

Result: every existing caller that doesn't set a budget sees zero
behavior change. The feature is purely additive.

**Q: What happens when the breach fires mid-loop?**

`BudgetExceededError` throws from `complete()`, propagates up through
AptKit's agent loop, out through `DiagnosticAgent.investigate`, into
the route's `try / catch` block. The catch emits a graceful NDJSON
`error` event with the tracker's snapshot in the message. The
`finally` block still fires — the summary log records how many
phases completed before the throw. The `sessionStorage` stash never
happens because the `done` event never fires.

The browser sees an error state; the user sees "budget exceeded."

**Q: Why share the tracker across `DiagnosticAgent` +
`RecommendationAgent`?**

Because the business unit that has a dollar cap is *the investigation*,
not the individual agent. A diagnostic that finds a hard case might
burn more; then recommendation gets a tighter remaining budget. That's
the intended semantics: total investigation cost is what's bounded.

The receipt records the shared snapshot — so eval retrospectives can
attribute spend to phases even though the ceiling is joint.

## See also

- `04-capability-trace-fanout.md` — the raw event stream that
  `summarizeUsage` folds into the tracker's inputs (via the
  `onCapabilityEvent` hook on the eval path; on the route path the
  adapter feeds the tracker directly from the response).
- `03-per-phase-timing-log.md` — where the breach shows up as a
  partial `phases[]` array in the summary log.
- `02-receipts-as-evidence.md` — the `budget.snapshot` field that
  proves the guard was live even when the ceiling wasn't hit.

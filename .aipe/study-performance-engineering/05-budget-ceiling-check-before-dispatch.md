# 05 · Budget ceiling — check before dispatch

**Circuit breaker on cost · Industry standard.** Also called *cost
guardrail* or *spend cap*. The check-before-dispatch discipline is
the distinguishing feature: the gate fires at the boundary that
would spend money, not after the money has been spent.

## Zoom out — where the gate sits

Inside the ModelProvider adapter, between the ReAct loop that
decides "make another turn" and the Anthropic client that
executes it.

```
  Zoom out — where the budget gate lives

  ┌─ Agent loop (AptKit) ─────────────────────────────────────┐
  │  ReAct: think → tool_use → tool_result → think → …         │
  │  decides: "one more turn"                                  │
  └─────────────────────────────┬─────────────────────────────┘
                                │  modelProvider.complete(request)
  ┌─ AnthropicModelProviderAdapter ─▼─────────────────────────┐
  │                                                            │
  │   ★ if (this.budget?.exceeded()) throw BudgetExceededError │
  │                                                            │
  │  else: anthropic.messages.create(params)                   │
  │        │                                                   │
  │        ▼                                                   │
  │  budget.add({ inputTokens, outputTokens })                 │
  │  return response                                           │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in — the one-word discipline: BEFORE.** The gate checks
`budget.exceeded()` BEFORE the API call, not after. That means a
runaway loop hits the ceiling with the *previous* turn's cost, and
the *current* turn is refused. Money doesn't leak past the
ceiling by the value of the last call.

## Structure pass — layers, axis, seams

**Layers.** Runner (route or eval) → agent → adapter → API. Each
layer knows about the budget in a different way:

  → **Runner** constructs the `BudgetTracker` with the ceiling.
  → **Agent** never knows the tracker exists (it's an opaque hook).
  → **Adapter** checks the tracker on every call.
  → **API** is uninvolved.

**Axis: what direction does information flow — accumulation up,
refusal down?**

```
  Axis — "how does the budget see and act?"

    accumulation UP the stack       refusal DOWN the stack
    ────────────────────────         ──────────────────────
    tokens flow: API → adapter       ceiling check: adapter
                 → tracker.add()      → decides: dispatch or throw
    (response.usage summed in         (BEFORE the API call fires)
     after every response)

    the tracker is read-only from     the tracker is written
    the API's perspective              from the adapter's perspective
```

**Seams.** The seam that matters is the one between "the tracker
knows the current total" and "the adapter is about to dispatch."
That seam is checked at `aptkit-adapters.ts:64-66`. Move the check
after the dispatch and the whole semantics flip from "no more
spending" to "one more turn of spending, then no more."

## How it works

### Move 1 — the mental model

You already know how a circuit breaker in an electrical panel
works: current is monitored, if it exceeds a threshold the breaker
TRIPS and no more current flows. The check happens continuously,
not after the panel catches fire. `BudgetTracker.exceeded()` is
the current sensor; the `throw BudgetExceededError` is the trip.

```
  Pattern — check-then-dispatch (the two orderings)

    ✓ RIGHT: check-BEFORE-dispatch
    ┌──────────────────────────────────────┐
    │  if (exceeded) throw                  │
    │  dispatch()                           │
    │  add(cost)                            │
    └──────────────────────────────────────┘
    → ceiling holds; last accepted call is under it

    ✗ WRONG: check-AFTER-dispatch
    ┌──────────────────────────────────────┐
    │  dispatch()                           │
    │  add(cost)                            │
    │  if (exceeded) throw                  │
    └──────────────────────────────────────┘
    → ceiling breached by the value of one call
    → runaway loop always spends N + 1 calls of cost
```

**Skeleton part everyone forgets.** The check must not require
knowing the cost of the *pending* call. `budget.exceeded()` uses
only accumulated history. If it tried to predict "will this next
call push us over?", it would need a token estimator — and would
be wrong on the tokens-out dimension (only the response knows).
Checking on history alone is the correct kernel.

### Move 2 — walking the mechanism

#### The tracker

`lib/agents/budget.ts:41-71`:

```ts
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
    // …returns tokens + estimated cost
  }

  exceeded(): boolean {
    const s = this.snapshot();
    if (this.limit.maxTokens != null && s.totalTokens > this.limit.maxTokens) return true;
    if (this.limit.maxCostUsd != null && s.estimatedCostUsd > this.limit.maxCostUsd) return true;
    return false;
  }
}
```

**Two axes: tokens OR cost.** Either limit can be set; both can be
set (whichever trips first wins). The tokens axis is deterministic
(counting the same numbers Anthropic returns). The cost axis is
estimated via `estimateAnthropicCost` (pricing table applied to
the token counts). Neither needs a network call — the check is
O(1) local math.

**Cache-tier undercount.** `add()` uses `input_tokens` only —
Anthropic's `cache_read_input_tokens` and
`cache_creation_input_tokens` are separate fields not exposed by
aptkit's `model_usage` event. The tracker is therefore slightly
conservative when caching is on (real spend is a bit higher than
tracked), which is the safer direction for a ceiling. See
`03-prompt-caching-ephemeral-breakpoint.md` for the parallel
discussion.

#### The gate

`lib/agents/aptkit-adapters.ts:59-66`:

```ts
async complete(request: ModelRequest): Promise<ModelResponse> {
  // Phase-3 budget-ceiling gate: check BEFORE dispatching the API call
  // so a runaway loop can't burn additional cost after the ceiling has
  // already been hit. Route handler catches this and emits a graceful
  // NDJSON `error` event.
  if (this.budget?.exceeded()) {
    throw new BudgetExceededError(this.budget.snapshot(), this.budget.limit);
  }
  // …then dispatch anthropic.messages.create(...)
```

**Why throw and not return an error result.** The AptKit `complete`
contract is: return a `ModelResponse` on success, throw on failure.
Wrapping the ceiling as an exception lets it propagate through the
ReAct loop's normal error path — the loop terminates, the agent
class returns to the route, the route's try/catch emits a
graceful NDJSON `error` event to the client. No new plumbing.

#### The accumulate-then-continue

`lib/agents/aptkit-adapters.ts:107-110`:

```ts
this.budget?.add({
  inputTokens: response.usage.input_tokens,
  outputTokens: response.usage.output_tokens,
});
```

**Called after every successful dispatch.** The pattern is:

```
  loop:
    if exceeded: throw
    dispatch
    accumulate
    return response
    (agent decides: another turn? → loop)
```

Every turn's cost is added to history, so the NEXT turn's check
sees it. This is the linear-time cost tracking that makes the
gate work at all — without accumulation, `exceeded()` would always
return false and the gate would never fire.

#### The `?.` — budget is optional

The tracker is passed as an optional constructor arg
(`aptkit-adapters.ts:53` `private readonly budget?: BudgetTracker`).
When callers don't pass one (older routes, agent-only tests), the
`?.` on `budget?.exceeded()` and `budget?.add()` no-ops. Behavior
is unchanged for callers that don't opt in. This is what let the
budget feature ship without touching every agent construction site.

### Move 3 — the principle

Guard the resource at the boundary that spends it, not after. Cost
control after the fact isn't cost control — it's cost reporting.
The distinguishing discipline of a real ceiling is that spending
STOPS at the ceiling; anything else is an accounting log with an
optimistic name. This generalizes: rate limits check before
dispatching (§02); tool timeouts fire before the fetch hangs (§01);
cost ceilings refuse before the API call. Same pattern, different
resource.

## Primary diagram

```
  Full lifecycle of one ReAct loop with budget ceiling

  runner constructs:
    budget = new BudgetTracker({ maxCostUsd: 2.0 })
    adapter = new AnthropicModelProviderAdapter(..., budget)
    agent   = new DiagnosticAgent(adapter, ...)

  agent.investigate(anomaly, { budget, ... })
    ┃
    ▼  turn 1
   ┌──────────────────────────────────────┐
   │ modelProvider.complete(request)       │
   │                                       │
   │  budget.exceeded()?                   │
   │    turns=0, tokens=0, cost=$0.00      │
   │    → false                            │
   │                                       │
   │  dispatch → response                  │
   │    usage = { input:3400, output:512 } │
   │                                       │
   │  budget.add(usage)                    │
   │    turns=1, tokens=3912, cost=$0.03   │
   └──────────────────────────────────────┘
    ┃  more turns…
    ▼  turn N
   ┌──────────────────────────────────────┐
   │ modelProvider.complete(request)       │
   │                                       │
   │  budget.exceeded()?                   │
   │    turns=N-1, tokens=…, cost=$2.02    │
   │    → TRUE                             │
   │                                       │
   │  throw BudgetExceededError            │──►  route catches
   └──────────────────────────────────────┘     emits NDJSON error
                                                 dispose datasource
                                                 log phase timings
```

## Elaborate

**Where the pattern comes from.** Circuit breakers come from
electrical engineering (physical fuses), landed in software via
Hystrix (Netflix, 2011), and are now standard in any resilient RPC
client. The variant here — dollar-denominated instead of
error-rate-denominated — is native to the LLM era: circuit
breakers used to guard failure rates; now they also guard cost
because every call has a metered price.

**Why "phase-3" in the code comments.** The comments name a Phase-3
epic. Phase-1 was the agents themselves; Phase-2 was
observability (`onCapabilityEvent`); Phase-3 added the cost
guardrail and the prompt cache; Phase-4 was the load harness and
fault injector. The `budget?` optional constructor arg is the
seam that let Phase-3 ship without breaking Phase-2 wiring —
covered in `study-software-design`.

**Cross-link.** `study-ai-engineering` walks WHY LLM apps need a
cost ceiling in the first place (per-call pricing, retry loops
that stack cost, ReAct loops that can spiral if the agent
mis-uses tools). This file measures the mechanism; that one names
the problem class.

## Interview defense

### Q1 · "Walk me through your cost guardrail."

**Answer.** A `BudgetTracker` gets constructed per-investigation
by the runner (route handler or eval) with a `maxCostUsd` ceiling
(default $2). It's passed as an optional constructor arg to the
`AnthropicModelProviderAdapter`. On every `complete()` call the
adapter checks `budget.exceeded()` BEFORE dispatching — that's the
key discipline. If exceeded, it throws `BudgetExceededError`; the
error propagates through the ReAct loop, out to the route, into
the graceful NDJSON error path. If not exceeded, it dispatches
and then `budget.add(usage)` with the response's token counts so
the next turn's check sees the updated total. The gate is
optional — callers that don't pass a tracker see identical
behavior to before the feature shipped.

```
  loop:
    if budget.exceeded(): throw    ← BEFORE
    response = dispatch()
    budget.add(response.usage)
```

**One-line anchor.** "Check history-based `exceeded()` BEFORE
dispatch; throw stops the loop; response's usage feeds the next
check."

### Q2 · "Why check before dispatch instead of after?"

**Answer.** Two reasons. First, correctness of the ceiling: check-
after would let one more full-cost call through past the ceiling.
For a $2 cap with a ~$0.09/turn cost, that's ~4% overshoot every
time — which is fine at $2 but scales badly if the ceiling is
$0.20 and the turn cost is $0.05. Second, honesty of the semantics:
"budget exceeded" should mean "we don't spend more," not "we spent
more and now we're stopping." Users and Ops set ceilings based on
the first meaning; check-after violates that expectation.

**One-line anchor.** "Check-after is cost REPORTING, not cost
CONTROL."

### Q3 · "What breaks if there's no accumulation between calls?"

**Answer.** Without `budget.add()` after each response,
`budget.exceeded()` always returns false — the tracker's totals
never grow. The gate becomes a no-op. This is the pair to the
check-before-dispatch discipline: the check needs history to be
meaningful, and the accumulation is what builds the history.
Together they form the two-line kernel: `if (exceeded) throw` +
`add(usage)`. Drop either and the whole gate collapses.

**One-line anchor.** "Check-before-dispatch needs
accumulate-after-response; they're two halves of the kernel."

### Q4 · "The prompt cache says you undercount cache tokens — does that let a runaway loop escape?"

**Answer.** Yes, marginally. Cache-read tokens cost ~0.1× normal
input; they aren't summed into `input_tokens`, so the tracker
misses that fraction. For a $2 ceiling and ~80% cache hit rate on
the system prompt, we might undercount by ~10–15% total. The gate
still fires; it just fires a bit later than the true spend
suggests. The comment at `aptkit-adapters.ts:105-106` names this
as "slightly conservative" — the direction is right (ceiling gets
respected earlier in real terms than it appears to), even if the
absolute number drifts. Named as a known bound; the fix (sum the
cache-tier costs) waits for aptkit's `model_usage` event to
expose them.

**One-line anchor.** "Undercount is in the safe direction; real
spend hits ceiling before tracked spend, not after."

## See also

- `01-route-budget-and-timeout-composition.md` — the parallel
  ceiling on wall-clock (300s) and per-call time (30s).
- `03-prompt-caching-ephemeral-breakpoint.md` — the cache-tier
  undercount lives here.
- `06-load-harness-semaphore-concurrency.md` — the runner
  constructs `BudgetTracker` per-investigation from
  `BUDGET_PER_INVESTIGATION_USD`.
- `study-ai-engineering` — why the cost dimension is unique to
  LLM apps and demands its own guardrail.

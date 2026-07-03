# RFC-07 — Per-investigation budget ceiling

**Decision in one line:** Every investigation carries a shared `BudgetTracker` across its diagnostic + recommendation agents. The tracker is checked **before** each model dispatch — so a runaway loop can't spend past the ceiling — and throws `BudgetExceededError` which the route handler emits as a graceful NDJSON `error` event.

---

## Context

Blooming's ReAct loop makes ~10 model calls per agent invocation. Multiply by two agents in a full diagnose+recommend pipeline and a single investigation is ~20 model turns at ~$0.09 in real per-case measurement (baseline runId `2026-07-03T04-08-28-644Z`).

That's the well-behaved case. The failure modes make this unbounded:

- **Runaway ReAct loops.** A model that keeps calling tools instead of concluding — the loop terminates only when the model emits a final assistant message. Nothing in the ReAct contract guarantees termination.
- **Prompt-injection loops.** A malicious tool output that instructs the model to keep querying. Same failure shape, different origin.
- **Degenerate reasoning.** A hard case where the model genuinely can't converge and thrashes on tool_result parses.

Vercel's `maxDuration = 300` on the streaming routes caps wall-clock, but wall-clock isn't the right budget. A stalled model turn at maxDuration=300 could still emit N=30 tool calls at premium input+output token cost. The ceiling should be denominated in what actually gets billed: tokens (and by extension, USD).

---

## Decision

Introduce a `BudgetTracker` (`lib/agents/budget.ts`) with two knobs — `maxTokens` and `maxCostUsd` — shared by every agent within a single investigation. The tracker is checked **before** each `messages.create` dispatch in the `AnthropicModelProviderAdapter` (the ModelProvider seam from RFC-06). Exceeding the limit throws `BudgetExceededError`, which propagates up through the AptKit loop, the agent wrapper, and the route handler's try/catch — which emits a graceful NDJSON `error` event.

```
The lifecycle — one tracker, two agents, check-before-dispatch

  ┌─ route handler (per investigation) ──────────────────────────────┐
  │  tracker = new BudgetTracker({ maxCostUsd: 0.50 })                │
  │                                                                    │
  │  diagnostic.run(anomaly, { tracker })                             │
  │    → AnthropicModelProviderAdapter.complete()                     │
  │        if tracker.exceeded(): throw BudgetExceededError            │
  │        response = anthropic.messages.create(...)                  │
  │        tracker.add(response.usage)                                │
  │                                                                    │
  │  recommendation.run(diagnosis, { tracker })  ← SAME tracker        │
  │    → same guard, same accumulation                                │
  └────────────────────────────────────────────────────────────────────┘

  where the guard sits
  ┌──────────────────────────────────────────────────────────────────┐
  │  BEFORE dispatch (chosen):                                        │
  │    if tracker.exceeded():                                          │
  │       throw BudgetExceededError                                    │
  │    ← model call never happens; ceiling holds byte-for-byte         │
  │                                                                    │
  │  AFTER dispatch (rejected):                                        │
  │    response = model.call()                                         │
  │    tracker.add(response.usage)                                    │
  │    if tracker.exceeded():                                          │
  │       throw BudgetExceededError                                    │
  │    ← the runaway call already happened; ceiling was retroactive    │
  └──────────────────────────────────────────────────────────────────┘
```

The tracker is intentionally simple. No per-agent breakdown, no cache-tier accounting (AptKit's `model_usage` event doesn't expose `cache_read_input_tokens`, so the tracker is deliberately conservative — it undercounts cache-read savings, which means the ceiling holds even tighter than nominal). Cost math uses Blooming's own `estimateAnthropicCost` helper — the same numbers the eval report uses.

---

## Alternatives considered

**(a) Invocation-level try/catch retry.** Wrap each agent call in a try/catch and let the cost naturally cap by "one investigation is at most one attempt." Loses because the failure this defends against isn't "the agent threw" — it's "the agent didn't throw, but it kept spending." A try/catch never fires; the runaway loop burns budget until wall-clock runs out. This alternative describes error handling, not budget enforcement.

**(b) Per-agent independent budgets.** DiagnosticAgent gets its own tracker with its own ceiling; RecommendationAgent gets a separate one. Loses because the load-bearing constraint is "total spend per investigation," not "spend per agent." A diagnostic that burns 80% of the pipeline budget shouldn't get to run a full-budget recommendation on top. Shared tracker is the shape that matches the constraint.

**(c) Rely on Vercel's `maxDuration = 300`.** Wall-clock is already bounded, so who cares. Loses (repeated from context because a reviewer will raise this specifically): wall-clock and cost are different budgets. A single 30-second model call at 100K input tokens costs more than five 5-second calls at 10K each — but wall-clock says the first is fine and the second is at the edge. The billing dimension is tokens; the guardrail should be denominated in tokens.

**(d) Anthropic's own rate limits.** Let 429s fail the loop. Loses because rate limits fire at a much higher threshold than a single investigation should ever hit — they defend the platform, not the app's budget. A user could burn $10 in one investigation before the 429 fires.

---

## Consequences

**What this buys:**
- **A byte-for-byte spending ceiling.** Once the tracker crosses the limit, no additional model call happens. The check-before-dispatch position is load-bearing here: a runaway loop can spend up to one turn past the limit at most (the turn that noticed the ceiling was hit), never more.
- **Shared across agents in the same investigation.** The diagnostic can't use up its "quota" and then have recommendation run fresh. Total cost per user click is bounded.
- **Graceful UI failure.** Because the error propagates to the route handler's error path, the user sees "investigation exceeded budget" in the streamed NDJSON — not a blank screen or an infinite spinner.
- **Eval-friendly.** The eval runner threads a `BudgetTracker` through the same hooks the route handler uses. Runaway eval cases surface in receipts as `BudgetExceededError` rather than turning the eval bill into a lottery.

**What it costs:**
- **Production wiring for route handlers is not yet complete.** Today the tracker is threaded through in the eval harness; the graceful-NDJSON error path in the route handlers exists as a `try/catch` but the tracker isn't instantiated per-investigation in prod. This is the known gap — noted in the Open Questions.
- **Under-counts cache-read savings.** Because AptKit's `model_usage` event doesn't distinguish `cache_read_input_tokens` from `input_tokens`, the tracker treats a cache hit as full-price input. Effect: the tracker is *conservative* — the real ceiling in dollars is slightly higher than what the tracker thinks. Safe direction, but if the ceiling is tight you'll see false-positive `BudgetExceededError`s that a cache-aware tracker would let through.
- **Config surface.** Each caller has to decide `maxTokens` vs `maxCostUsd` vs both. Today evals use `maxCostUsd`; when production is wired, we'll pick one per environment. Documented as a simple `BudgetLimit` type.

**What the reviewer will push on:**
> "Why not defer this until you have a real cost incident?"

Own the answer: the incident is the wrong forcing function for a budget ceiling. Once a runaway happens in production, you've already paid the bill. This is one of the small class of primitives that has to exist before the first failure — like rate-limiting a login endpoint before anyone tries brute force. The implementation is 100 LOC and one adapter change. The cost of not having it is one bad prompt-injection loop that runs for the full `maxDuration = 300`.

---

## Open questions

- **Production route-handler wiring.** The `try/catch` path in `/api/agent` already emits NDJSON `error` events. The remaining work is: instantiate a `BudgetTracker` per request in the route handler (with an env-var configured ceiling), thread it through both agent calls, catch `BudgetExceededError` specifically and emit a distinct `error` kind so the UI can render a "budget exceeded" panel instead of the generic "something went wrong."
- **Token budget vs cost budget.** Today both knobs exist. Cost budget is more intuitive ("$0.50 per investigation") but drifts as Anthropic pricing changes. Token budget is stable but requires knowing the model's per-token cost to make it meaningful. Likely we pick cost for prod, token for evals.
- **Multi-investigation aggregation.** A user who kicks off five investigations quickly should hit a daily/hourly cap, not just per-investigation caps. Not built — would need session-scoped or user-scoped tracker persistence, which conflicts with RFC-01's no-DB stance. Deferred.

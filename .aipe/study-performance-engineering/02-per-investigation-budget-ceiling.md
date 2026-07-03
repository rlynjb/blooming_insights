# per-investigation budget ceiling

**Industry name(s):** budget ceiling · cost cap · check-before-dispatch guard. **Type label:** Industry standard.

## Zoom out — where the ceiling sits

The ceiling lives at the seam between the agent (the ReAct loop) and the provider (the Anthropic client). Every turn passes through the check.

```
Zoom out — the ceiling seam

┌─ Service band ──────────────────────────────────────────────┐
│  DiagnosticAgent / RecommendationAgent (ReAct loop)          │
│  turn 1: build request, call model                           │
│  turn 2: parse tool_use, run tool, append tool_result        │
│  turn N: model returns final text, loop exits                │
└───────────────────────────┬─────────────────────────────────┘
                            │  every turn
                            ▼
┌─ Provider adapter (Blooming) ───────────────────────────────┐
│  AnthropicModelProviderAdapter.complete()                    │
│  ★ if (budget.exceeded()) throw BudgetExceededError ★         │ ← we are here
│  else: dispatch to Anthropic, add usage to tracker            │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─ Anthropic API ─────────────────────────────────────────────┐
│  charges $ for tokens                                        │
└─────────────────────────────────────────────────────────────┘
```

**Zoom in — what it is.** A `BudgetTracker` is created once per investigation, threaded through the agent hooks, and consulted by the provider adapter before every model call. If the accumulated spend has crossed the limit, the adapter throws `BudgetExceededError` *before* the next Anthropic call goes out. That's the distinction that matters — the check happens on the sending side, not the receiving side, so a runaway ReAct loop can't burn additional cost after the ceiling is crossed.

## Structure pass — layers · one axis · one seam

The axis worth tracing is **who can cause spend**. Hold it across three layers:

```
one axis held: "who can cause the next dollar to spend?"

┌─ route handler ──────────────────────────────┐
│  creates BudgetTracker(limit)                 │  → tracker OWNS the ceiling
└──────────────────────┬────────────────────────┘
                       │  seam: passes tracker into agent hooks
┌─ agent (ReAct loop) ─▼───────────────────────┐
│  every turn: call provider.complete()         │  → agent COULD spend
└──────────────────────┬────────────────────────┘
                       │  seam: adapter.complete() checks BEFORE dispatch
┌─ provider adapter ───▼───────────────────────┐
│  if exceeded → throw                          │  → adapter GATES the spend
│  else → dispatch, add usage back to tracker   │  → tracker LEARNS from the answer
└───────────────────────────────────────────────┘
```

**The seam.** Two joints matter: (1) the tracker is passed into the hooks by the caller, so the caller sets the limit; (2) the adapter checks the tracker before dispatching, so the check is on the sending side. Removing either turns the ceiling into a monitor, not a guard.

## How it works

### Move 1 — the mental model

You know how a credit card's spending limit works: the *card issuer* declines the transaction if you cross the limit, not the merchant. The check is on the way out, not on the way back. Prompt-budget ceilings work the same way. The provider adapter is the card issuer; the model call is the transaction; the ceiling is the credit limit.

```
The pattern — the check happens BEFORE the API call

turn N:                        turn N+1:
┌──────────────────┐           ┌──────────────────┐
│ build request    │           │ tracker: exceeded? │
│ (system + tools) │           │   NO  → dispatch    │
└────────┬─────────┘           │   YES → throw ★     │
         │                     └────────┬───────────┘
         ▼                              │
   ANTHROPIC API                        │
         │                              ▼
         ▼                       ┌──────────────────┐
  usage: {in, out} ──── tracker  │  route handler:  │
         │             .add()    │  catch, emit     │
         │                       │  NDJSON error    │
         ▼                       └──────────────────┘
   next turn: check, dispatch
```

The load-bearing part is the *order*: check-before-dispatch. If the check happened after, you'd catch the overspend on turn N+1 having already paid for turn N.

### Move 2 — the step-by-step walkthrough

#### Step 1 — build the tracker at the request boundary

`eval/run.eval.ts:194`:

```typescript
const budgetLimitUsd = Number(process.env.BUDGET_MAX_USD ?? '2.0');
const budget = new BudgetTracker({ maxCostUsd: budgetLimitUsd });
```

One tracker per investigation. Shared across the DiagnosticAgent and the RecommendationAgent that follow — the same instance is passed into both, so the ceiling counts *total* spend across the investigation, not per-agent spend.

**What breaks if you build one tracker per agent:** the ceiling is really 2× the intended cap, because diagnose + recommend each get their own $2.00. Subtle bug you'd only catch in the receipts. The shared-instance shape prevents it.

#### Step 2 — thread it through the agent hooks

`lib/agents/diagnostic.ts:30`:

```typescript
budget?: import('./budget').BudgetTracker;
```

The `AgentHooks` type has an optional `budget` field. `DiagnosticAgent.investigate` at line 46 receives hooks and passes `hooks.budget` into the adapter constructor at line 54:

```typescript
const agent = new AptKitDiagnosticInvestigationAgent({
  model: new AnthropicModelProviderAdapter(
    this.anthropic,
    'diagnostic',
    this.sessionId,
    undefined,
    undefined,
    hooks.budget,   // ← the tracker gets bound to the adapter here
  ),
  ...
});
```

**What breaks if you skip this line:** the adapter has no tracker, so the `budget?.exceeded()` check at `aptkit-adapters.ts:64` is always false. The ceiling is dead code. The plumbing has to reach the check site — this is why the tracker is on the adapter, not on the agent class.

```
Layers-and-hops — tracker plumbing from caller to check site

┌─ Caller (route or eval) ─┐  hop 1: new BudgetTracker({ maxCostUsd })
│  build tracker           │ ────────────────────────────────────────┐
└──────────────────────────┘                                         │
                                                                      ▼
                                                    ┌─ DiagnosticAgent ───────┐
                                                    │  investigate(anom,       │
                                                    │    { budget: tracker })  │
                                                    └────────┬────────────────┘
                                                             │  hop 2: pass to adapter
                                                             ▼
                                                    ┌─ AnthropicAdapter ──────┐
                                                    │  constructor stores it  │
                                                    │  complete() checks it   │
                                                    └────────┬────────────────┘
                                                             │  hop 3: before every API call
                                                             ▼
                                                    ┌─ Anthropic API ─────────┐
                                                    │  charges $ for tokens   │
                                                    └────────┬────────────────┘
                                                             │  hop 4: usage back
                                                             ▼
                                                    ┌─ tracker.add(usage) ────┐
                                                    │  running total updates  │
                                                    └─────────────────────────┘
```

#### Step 3 — the check-before-dispatch guard

`lib/agents/aptkit-adapters.ts:64`:

```typescript
async complete(request: ModelRequest): Promise<ModelResponse> {
  // Phase-3 budget-ceiling gate: check BEFORE dispatching the API call
  // so a runaway loop can't burn additional cost after the ceiling has
  // already been hit.
  if (this.budget?.exceeded()) {
    throw new BudgetExceededError(this.budget.snapshot(), this.budget.limit);
  }
  // ... build params, call Anthropic
}
```

The check runs every turn. `exceeded()` compares the running total against `maxTokens` or `maxCostUsd`; either one triggers the throw. `BudgetExceededError` carries the snapshot so the caller can emit a graceful error message with the real numbers.

**What breaks if you check AFTER the API call:** you catch the overspend one turn late, having already paid for that turn. In a ReAct loop that's ~$0.01-0.02 of extra spend per turn, but the shape is what's wrong: the ceiling now *reports* the breach, it doesn't *prevent* it.

#### Step 4 — feed usage back into the tracker

`lib/agents/aptkit-adapters.ts:107`:

```typescript
this.budget?.add({
  inputTokens: response.usage.input_tokens,
  outputTokens: response.usage.output_tokens,
});
```

Every successful response updates the tracker. Next turn's `exceeded()` call sees the fresh total.

**Design note in the code:** "Uses `inputTokens` (not cache_read tokens — those aren't exposed by aptkit's model_usage event) so the tracker is slightly conservative when caching is on: it undercounts the cache-read fraction." The tracker is intentionally slightly conservative — it counts cache-read tokens at full input cost. That means the ceiling trips a hair earlier than the true spend justifies. Fine, on purpose: the ceiling should over-count under uncertainty, not under-count.

#### Step 5 — the throw propagates up as a graceful NDJSON error

The route handler at `app/api/agent/route.ts:303` has a `try/catch` around the whole stream body:

```typescript
} catch (e) {
  if (e instanceof DOMException && e.name === 'AbortError') {
    return;
  }
  console.error('[agent] error:', redactSecrets(formatError(e)));
  send({
    type: 'error',
    message: `/api/agent · ${e instanceof Error ? e.message : String(e)}`,
  });
}
```

`BudgetExceededError` extends `Error` and carries a message like `Investigation budget exceeded: 452,193 tokens / $2.170 vs limit $2.000`. The client sees an NDJSON `error` event with that message. The reasoning trace stops at the last successful turn, the recommendation card never renders, the user sees a real error not a silent hang.

### Move 3 — the principle

A budget ceiling that catches overspend after the fact is a monitor, not a guard. The check has to run on the sending side, before the transaction. That's the load-bearing shape — the same shape a credit card issuer, a rate limiter, and a firewall all share. The tracker itself is trivial (accumulate, compare); the discipline is putting the check where it can prevent the spend, not just observe it.

## Primary diagram — the recap

```
The budget-ceiling pattern — end to end

┌─ Caller (route / eval) ─────────────────────────────────────────┐
│  const budget = new BudgetTracker({ maxCostUsd: 2.0 })           │
│  eval/run.eval.ts:195                                            │
│  Same instance shared between diagnose + recommend               │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               │  investigate(anomaly, { budget })
                               ▼
┌─ DiagnosticAgent / RecommendationAgent ─────────────────────────┐
│  AptKit ReAct loop: turn 1 → turn N                              │
│  each turn calls provider.complete()                             │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               │  complete(request)
                               ▼
┌─ AnthropicModelProviderAdapter ─────────────────────────────────┐
│                                                                  │
│   BEFORE dispatch:  if (budget.exceeded())                       │
│                       throw BudgetExceededError                  │
│                     lib/agents/aptkit-adapters.ts:64             │
│                                                                  │
│   AFTER response:   budget.add({                                 │
│                       inputTokens,  ← includes cache reads       │
│                       outputTokens                               │
│                     })                                           │
│                     lib/agents/aptkit-adapters.ts:107            │
│                                                                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               │  throws propagate up
                               ▼
┌─ Route handler catch block ─────────────────────────────────────┐
│  send({ type: 'error', message: '...' })                         │
│  Client sees graceful NDJSON error event                         │
│  Reasoning trace stops at last successful turn                   │
└──────────────────────────────────────────────────────────────────┘
```

## Elaborate

The pattern comes from cloud-cost land — "spending caps" on AWS Budgets, GCP billing alerts, OpenAI's per-org spend limits. Those are all *reporting* budgets (they email you when you cross), not *enforcement* budgets. The enforcement version — refuse the next call, don't just warn — is rarer and cost-sensitive by design.

The ceiling in this repo is defensive, not economic. At $2.00 vs observed $0.09/case, it's a **~22× overhead** — the ceiling exists to catch runaway loops, not to shave the normal-path bill. A prompt bug that made the model call `execute_analytics_eql` in an infinite loop of retries would burn $10-50 in a few minutes without it. With it, the loop stops at $2.00 and the caller emits a real error.

**Adjacent primitive worth naming.** This is the same shape as a rate limiter, but on cost instead of request count. A rate limiter says "no more than N requests per T seconds"; the budget ceiling says "no more than $M cost per investigation." Both check BEFORE dispatch. Both throw a typed error the caller catches. If you've built one, you've built the other.

**What to read next.** `01-prompt-caching.md` for how caching interacts with the tracker (the tracker undercounts cache reads on purpose). `03-observability-report.md` for how the same usage data flows into per-run cost math.

## Interview defense

**Q: Walk me through the budget ceiling and where it fires.**

The load-bearing move is check-before-dispatch. The `BudgetTracker` is created once per investigation with a `maxCostUsd` limit — default $2.00. It gets passed through the agent hooks into the Anthropic provider adapter. Every model turn, the adapter's `complete()` method calls `budget.exceeded()` *before* it dispatches to the Anthropic API. If the running total has crossed the limit, it throws `BudgetExceededError` — no API call happens, no additional cost. If it hasn't crossed, dispatch normally, then feed `response.usage` back into the tracker with `budget.add()`. The check-before-dispatch is the whole point: a runaway loop stops burning cost the moment the ceiling is hit, not one turn later. In this codebase the check is at `lib/agents/aptkit-adapters.ts:64` and the tracker is at `lib/agents/budget.ts`.

```
The anchor diagram to sketch

turn N              turn N+1
call complete()    call complete()
     │                  │
     ▼                  ▼
   [check]            [check]  ★ if exceeded → throw ★
     │                  │
     ▼                  ▼
   dispatch           NO dispatch
     │                  │
     ▼                  ▼
   usage back        ceiling holds
     │
     ▼
   tracker.add()
```

**Q: The tracker undercounts cache reads. Why is that OK?**

Two reasons. First, `aptkit`'s `model_usage` event only exposes `input_tokens` and `output_tokens` — it doesn't split out cache_read vs cache_creation, so I couldn't feed the distinction in even if I wanted to. Second, undercounting cache reads means the tracker counts every input token as if it were billed at 1×, when reads are actually billed at 0.1×. That makes the ceiling *conservative* — it trips earlier than the true spend justifies. Fine for a defensive ceiling. If I were using the tracker for economic optimization, not defense, I'd want to fix this.

**Q: What breaks if you skip the check-before-dispatch?**

Two failure modes. If you check after the dispatch, you catch the breach one turn late — that turn's spend is already burned. If you don't check at all, a runaway ReAct loop (say, the model keeps calling `execute_analytics_eql` because it doesn't like the schema) burns $10-50 before the route's 300s timeout kicks in. The Vercel-side timeout is a wall-clock cap, not a cost cap. Different failure surfaces.

**Q: Why $2.00 when the observed cost is $0.09/case?**

It's an escape valve, not a normal-path constraint. The ~22× overhead is deliberate — I'd rather the ceiling never fire in a healthy run than have false positives from a slow-but-legitimate case. If the eval starts routinely hitting $1.50/case, that's a signal to investigate the prompt or the agent loop, not to raise the ceiling.

## See also

- `01-prompt-caching.md` — why the tracker doesn't subtract cache reads (aptkit's usage shape).
- `03-observability-report.md` — the same usage data drives the report's cost column.
- `audit.md` §1 — performance-budget lens finding.

# Budget ceiling as cost-abuse defense

## Subtitle

Per-investigation token/cost ceiling with check-before-dispatch semantics · Industry standard (rate/spend limiter), Project-specific implementation (`BudgetTracker` + `BudgetExceededError`)

---

## Zoom out — where this concept lives

An agent loop is the closest thing this codebase has to unbounded work. Every model turn can decide to call another tool; the tool result feeds back into the next turn; the model decides again. Without a ceiling, a runaway loop — from a bug in the loop-termination heuristic, from prompt injection, from a hostile tool result that keeps the model "investigating" — burns model spend until Vercel's 300s route budget expires.

The `BudgetTracker` sits between the agent loop and the Anthropic API, checked *before* every turn. If the ceiling has already been hit, the next call never dispatches.

```
  Zoom out — where the budget ceiling sits

  ┌─ Service layer ──────────────────────────────────────────────┐
  │                                                                │
  │   ┌ Route handler (app/api/agent/route.ts) ─────────────────┐  │
  │   │  ★ Budget is built + tested but NOT WIRED here ★         │  │
  │   │  should construct: new BudgetTracker({ maxCostUsd })     │  │
  │   │  should thread:    ...agentHooks, budget                 │  │
  │   └────────────────────────┬─────────────────────────────────┘  │
  │                             │                                    │
  │                             │  hooks.budget                     │
  │                             ▼                                    │
  │   ┌ Agent adapter ─────────────────────────────────────────┐   │
  │   │  AnthropicModelProviderAdapter.complete(request):       │   │
  │   │    if (budget.exceeded()) throw BudgetExceededError    │  ★ │
  │   │    response = anthropic.messages.create(params)         │   │
  │   │    budget.add({ inputTokens, outputTokens })            │   │
  │   └────────────────────────┬─────────────────────────────────┘  │
  │                             │                                    │
  │                             ▼                                    │
  │                      Anthropic API                               │
  └────────────────────────────────────────────────────────────────┘
```

**Current state — the caveat:** the mechanism is fully built and exercised in `eval/run.eval.ts` and `eval/load.eval.ts`. It is *not* instantiated by the production route handlers. See Move 2.5.

---

## Structure pass — layers, axis, seams

**Layers.** Route handler → agent (`DiagnosticAgent` etc.) → AptKit's underlying loop → `AnthropicModelProviderAdapter.complete()` → Anthropic API.

**Axis: cost.** Every layer sees a different unit:

- Route: "one investigation" (a whole diagnose or diagnose+recommend cycle).
- Agent: "one loop invocation" (~5-15 turns).
- Adapter: "one model turn" (~1 API call, one input/output token pair).
- Anthropic API: "one billed request" (input tokens × input rate + output tokens × output rate).

The tracker aggregates all four into one number (running estimated USD spend across every turn of every agent in one investigation) and lets the caller declare a ceiling in that unit.

**Seam.** One boundary carries the defense: `AnthropicModelProviderAdapter.complete()`. This is the *only* place API calls happen; if the check is here, no code path bypasses it.

**Why check *before* dispatch, not after?** Because "check after" is closing the barn door post-departure. A runaway loop that burns 10× the ceiling on one call still cost you 10× — you noticed too late. Check before, and any turn past the ceiling never fires. The tracker undercounts by one turn's worth (the turn that pushed it over the line) but every subsequent turn is prevented, not billed-then-refused.

Hand off.

---

## How it works

### Move 1 — the mental model

You know how a rate limiter works? Same idea, different unit. Instead of "N requests per window" the unit is "N dollars per investigation." Instead of counting toward a rolling window it accumulates across one bounded scope. The "reset" happens implicitly at the end of the investigation because the tracker is a fresh instance per request.

The pattern's shape:

```
  Budget ceiling — the pattern (check before, add after)

              turn N about to fire
                     │
                     ▼
         ┌───────────────────────┐
         │ tracker.exceeded() ?   │
         └─────┬───────────────┬─┘
               │ yes           │ no
               ▼               ▼
         ┌───────────┐   ┌──────────────────────┐
         │ throw     │   │ anthropic.messages    │
         │ Budget    │   │ .create(params)       │
         │ Exceeded  │   │                       │
         └───────────┘   │ tracker.add(usage)    │
              │          └──────────┬────────────┘
              │                     │
              │                     ▼
              │              turn N+1 about to fire
              ▼                     │
         route catch                │
         emits NDJSON               ▼
         error event         (loop back to check)
```

The load-bearing part: `check → dispatch → accumulate`, in that order. The check is against the state *before* this turn; the accumulate updates state *after*.

### Move 2 — walkthrough

**The tracker.** Data-only. Two counters and a fixed limit.

**File:** `lib/agents/budget.ts`
**Class:** `BudgetTracker`
**Line range:** 41-77

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

Named parts, each by what breaks if removed:

- **Counters (`inputTokens`, `outputTokens`, `turns`)** — remove and the ceiling has no memory; the check compares zero to the limit forever.
- **`add()` after each response** — remove and the counters never grow; ceiling never fires.
- **`snapshot()` — pure derivation** — same numbers, different shape; removing breaks the read API without changing the accounting.
- **`exceeded()` — the decision** — remove and the caller has to inline the comparison; the class becomes data-only.

**The custom error.** Not a plain `Error`. `BudgetExceededError` carries the snapshot and the limit as public fields, so the catch site can log or emit exactly what tripped the ceiling.

**File:** `lib/agents/budget.ts`
**Class:** `BudgetExceededError`
**Line range:** 85-95

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

Two loud choices:

- `name = 'BudgetExceededError'` — distinct from generic Error so the route handler could branch on it if desired (currently it treats it as a normal error and emits the NDJSON `error` event via the existing catch — that's fine).
- Message includes both the actual spend and the limit — the log line tells you exactly what tripped it, no need to grep for the limit config.

**The check-before-dispatch site.** The seam. One place, in the adapter's `complete()` method.

**File:** `lib/agents/aptkit-adapters.ts`
**Class:** `AnthropicModelProviderAdapter`
**Method:** `complete`
**Line range:** 59-121

```ts
async complete(request: ModelRequest): Promise<ModelResponse> {
  // Phase-3 budget-ceiling gate: check BEFORE dispatching the API call
  // so a runaway loop can't burn additional cost after the ceiling has
  // already been hit. Route handler catches this and emits a graceful
  // NDJSON `error` event.
  if (this.budget?.exceeded()) {
    throw new BudgetExceededError(this.budget.snapshot(), this.budget.limit);
  }

  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = { ... };

  const response = await this.anthropic.messages.create(params, ...);

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

  return { ... };
}
```

Two trust decisions land in this method:

- **`this.budget?.exceeded()` uses optional chaining.** No budget = no check. This is what lets the tracker be additive — callers that don't opt in see identical behavior. It's also what lets the production routes get away with skipping it (a bug, not a feature).
- **Accumulate on `response.usage.input_tokens`**, not on the cache-read fraction. The comment names the tradeoff: when prompt caching is on (Phase 3, `params.system` with `cache_control: 'ephemeral'` at lines 85-88), the tracker undercounts by the cache-read savings. Conservative in the right direction — the tracker will fire *earlier* than the true cost would justify, never later.

**Where it's wired up (only): the eval runners.**

**File:** `eval/run.eval.ts`
**Line range:** 191-195

```ts
// per-agent spend. Limit sourced from BUDGET_MAX_USD env var
// default $2.0 which is well above any single investigation's cost
const budgetLimitUsd = Number(process.env.BUDGET_MAX_USD ?? '2.0');
const budget = new BudgetTracker({ maxCostUsd: budgetLimitUsd });
```

**File:** `eval/load.eval.ts`
**Line range:** 265

```ts
const budget = new BudgetTracker({ maxCostUsd: BUDGET_PER_INVESTIGATION_USD });
```

Both eval runners thread this through `AgentHooks.budget` to the adapter. **No production route does.**

Grep: `grep -rn "new BudgetTracker" app/` → nothing. `grep -rn "hooks.budget\|budget:" app/` → nothing. The routes construct their `hooksFor(agent)` object (`route.ts:196-210`) without a `budget` field, so the adapter's `this.budget` is undefined and `this.budget?.exceeded()` short-circuits to `false` forever.

### Move 2.5 — current state vs future state

The mechanism is built. The wiring is the fix.

```
  Phase A — now                        Phase B — after the wire-up
  ────────────                         ──────────────────────────
  eval: budget enforced                eval: budget enforced
  prod route: NO budget                prod route: budget enforced
                                                     │
                                                     │ Route handler:
                                                     │   const budget = new BudgetTracker({
                                                     │     maxCostUsd: Number(process.env.BUDGET_MAX_USD ?? '2.0'),
                                                     │   });
                                                     │
                                                     │ hooksFor(agent) → { ...existing, budget }
                                                     │
                                                     │ Existing catch block handles it:
                                                     │   send({ type: 'error', message: ... })
                                                     ▼
                                                 no other change required
```

Cost of the wire-up: ~5 lines per route, twice (agent + briefing). No new state, no infra, no config beyond the already-defined `BUDGET_MAX_USD` env var. The error path already exists — the route's catch block at `app/api/agent/route.ts:303-316` emits an NDJSON `error` event for any thrown error; `BudgetExceededError.message` is human-readable and will surface exactly what tripped.

### Move 3 — the principle

The generalizable rule: unbounded work needs a ceiling that fails closed at the API boundary, checked before dispatch. Not "log a warning if we're close" — a hard throw that the caller must handle. The pattern applies to any place your code hands work to an expensive external service in a loop: LLM calls, embedding calls, third-party API bulk operations. The specific mechanism here — a class with `add / snapshot / exceeded`, injected via optional hook, checked at the single dispatch site — generalizes to any of those.

For cost-abuse defense specifically, the "check before" ordering is the whole game. Everything else is bookkeeping.

---

## Primary diagram — the full defense

```
  Budget ceiling — end to end

  Route handler
  ─────────────
    const budget = new BudgetTracker({ maxCostUsd: 2.0 })
                                    │
                                    │  passed via hooks
                                    ▼
  Agent (DiagnosticAgent.investigate)
  ──────────────────────────────────
    const model = new AnthropicModelProviderAdapter(
      anthropic, 'diagnostic', sessionId, undefined, undefined,
      hooks.budget    ← the tracker instance
    )
                                    │
                                    │  used inside AptKit's loop
                                    ▼
  AptKit agent loop — for each turn:
  ──────────────────────────────────
    ┌──────────────────────────────────────────┐
    │ AnthropicModelProviderAdapter.complete()  │
    │                                            │
    │   if (budget.exceeded()) throw ★           │
    │                                            │
    │   response = anthropic.messages.create()   │
    │                                            │
    │   budget.add({                             │
    │     inputTokens: response.usage.input,     │
    │     outputTokens: response.usage.output,   │
    │   })                                       │
    └──────────────────────┬─────────────────────┘
                            │  if throw ★
                            ▼
  Route handler's catch block (route.ts:303-316)
  ──────────────────────────────────────────────
    send({
      type: 'error',
      message: '/api/agent · Investigation budget exceeded: ...',
    })
    console.error('[agent] error:', ...)
    // finally block still runs → dispose datasource, log phase summary
```

---

## Elaborate

**Why per-investigation, not per-request?** An "investigation" in this codebase spans potentially two API route calls: `?step=diagnose` on the investigate page, then `?step=recommend` on the recommend page. Right now the tracker is per-request in the eval (each `run.eval.ts` iteration is one full investigation), which matches. If step-splitting were wired to production, the tracker would need to be shared across the two requests — most likely via a per-investigation state entry keyed off `insightId`. Out of scope for the current defense; worth noting.

**Why undercount on cache reads?** Because AptKit's `model_usage` event doesn't expose cache token breakdown, and the Anthropic SDK returns `input_tokens` as the *effective* count (including cache reads at full rate for the tracker's math). Being conservative — assuming no cache savings — means the tracker will fire *slightly* earlier than the actual cost warrants. That's the safe direction; the alternative (assuming savings that didn't happen) would let a runaway loop keep going past the intended ceiling.

**Why `maxCostUsd` and `maxTokens` both, ORed?** Tokens are the accurate measure; USD is derived via the pricing helper. Callers can express the ceiling in either unit; usually only one is set. The OR is because they're expressing the same intent from different angles — the tighter one wins.

**Where the pattern came from.** Token buckets go back to the 1970s; the "check before dispatch, add after response" ordering is folklore from anyone who's ever run an API-bill-tracking system. The specific shape here — an optional injected tracker, throwing a distinct error type — is the same pattern used for request-quota gates in Google Cloud SDKs.

**Adjacent concept:** the `~1 req/s` rate limit in `BloomreachDataSource` (`lib/data-source/bloomreach-data-source.ts:129-137`). Same idea (limit expensive external work), different unit (calls per second, not USD per investigation), different failure mode (retry with backoff, not throw). Both are "the loop wants to go faster than the external service tolerates; here's the throttle."

**What to read next in this repo:** `03-read-only-tool-allowlist.md` — the other bound on what a runaway loop can do; the tool set is the *what*, this file is the *how much*.

---

## Interview defense

### Q: "Why check before dispatch instead of after?"

**Answer:** Because "check after" means you already paid for the call that pushed you over. A runaway loop that emits a 100k-token turn at the ceiling would still cost 100k tokens on that last turn. Check before, and the loop stops one turn *earlier* — the tracker undercounts by one turn's worth (the one that would have pushed it over) but every subsequent turn is prevented outright, not billed-then-rejected.

The trust axis version: the dispatch site is the trust boundary between your code and the paid service. The defense lives *at* the boundary, before the crossing.

**Diagram:**

```
  Check after (bad)              Check before (good)
  ─────────────────              ────────────────────
  dispatch  ──► pay              check ──► pay only if
       │                              │    below ceiling
       ▼                              │
  add usage                          ▼
       │                         if over: throw
       ▼                              │
  check ──► too late                 ▼
                                 no dispatch, no cost
```

**Anchor:** `lib/agents/aptkit-adapters.ts:59-66` — the check is the first thing `complete()` does.

### Q: "You say the ceiling is built but not wired. What's the risk right now?"

**Answer:** A runaway agent loop — from a bug in AptKit's termination heuristic, from prompt injection producing "always call another tool" behavior, from a Bloomreach tool result that keeps the model "investigating" — burns the entire 300s Vercel route budget in model spend. At claude-sonnet-4-6 pricing that's a bounded but real dollar exposure per malicious request. The infrastructure to prevent it exists. The wire-up is 5 lines per route. The reason it's not there is that the mechanism was built alongside the eval runner where it was needed first, and the production wire-up was deferred.

**Fix:** in `app/api/agent/route.ts` and `app/api/briefing/route.ts`, construct `new BudgetTracker({ maxCostUsd: Number(process.env.BUDGET_MAX_USD ?? '2.0') })` at request entry, pass it via `hooksFor(agent).budget`. The existing catch block already knows how to emit `BudgetExceededError` as an NDJSON `error` event.

**Anchor:** `eval/run.eval.ts:194-195` shows the exact instantiation; port it to the routes.

### Q: "Why is the tracker per-investigation, not global?"

**Answer:** Because the meaningful ceiling is per-user-action, not per-fleet-hour. If a global tracker existed, one user's runaway loop would trigger the ceiling for everyone else too. Per-investigation, each request has its own tracker; the fresh instance is what "resets" the budget at investigation boundaries. It also happens to be the natural scope for the cost accounting — one investigation is one "unit of value" delivered to the user, so putting a dollar ceiling on that unit is a business-shaped decision, not just a technical throttle.

**Anchor:** `lib/agents/budget.ts:5-7` (the design comment) and `eval/run.eval.ts:194` (one tracker per test case = one per investigation).

---

## See also

- `03-read-only-tool-allowlist.md` — bounds the *what* of a runaway loop
- `04-model-output-type-guards.md` — bounds the *shape* the loop's output can take
- `06-log-secret-redaction.md` — the log-side defense (any budget-exceeded log lines never carry tokens)
- `audit.md` § 7 (LLM and agent) — the lens finding; § 8 (red flags) — the checklist entry
- `00-overview.md` finding 3 — the wire-up gap this file documents

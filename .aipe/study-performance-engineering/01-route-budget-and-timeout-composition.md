# 01 · Route budget & timeout composition

**Composed deadline · Industry standard.** Also called *nested
deadline propagation* or *hierarchical time budgets*.

## Zoom out — where the budgets sit

Three budgets, one investigation. The route budget is the outer
bound; the tool timeout is the inner bound; the cost ceiling is
the money bound. They compose — each is a different axis.

```
  Zoom out — three budgets bound one investigation

  ┌─ Client (browser) ──────────────────────────────────────────┐
  │  useInvestigation → fetch() → readNdjson()                   │
  │  · one AbortController per mount                             │
  └────────────────────────────────┬────────────────────────────┘
                                   │  HTTP · NDJSON
  ┌─ Route (Vercel serverless) ────▼────────────────────────────┐
  │  /api/agent                                                  │
  │  ★ ROUTE BUDGET: maxDuration = 300s ★                        │
  │  · req.signal.throwIfAborted() between phases                │
  │  · BudgetTracker checks BEFORE every model turn              │
  │      ★ COST CEILING: ~$2 per investigation ★                 │
  └────────────────────────────────┬────────────────────────────┘
                                   │
                                   ▼
                    ┌─ MCP tool call boundary ────────────────┐
                    │  transport.callTool()                    │
                    │  ★ TOOL TIMEOUT: 30s ★                   │
                    │  composeSignals(req.signal,             │
                    │    AbortSignal.timeout(30_000))         │
                    └──────────────────────────────────────────┘
```

**Zoom in — what "composition" means.** The three budgets don't
substitute for each other. The route budget guards the wall clock;
the tool timeout guards any single call; the cost ceiling guards
spend. A single hanging MCP call would blow the wall clock without
the tool timeout. A runaway ReAct loop would blow the money without
the cost ceiling. The route budget alone can't protect either of
those without help.

## Structure pass — layers, axis, seams

**Layers.** From outer to inner: client → route → agent loop →
model call → tool call. Each layer has an owner and a budget it
enforces.

**Axis: who cancels who?** Trace `AbortSignal` down the stack.

```
  One axis — "who cancels this layer if the budget runs out?"

  ┌─ layer ─────────────────┐    signal from…             cancels via…
  │ client                  │    user closes tab          → fetch abort
  ├─────────────────────────┤
  │ route (300s)            │    req.signal.aborted       → throwIfAborted
  │                         │    (checked between phases)
  ├─────────────────────────┤
  │ agent loop              │    budget.exceeded()        → throw BudgetExceeded
  │ (BudgetTracker)         │    (checked before dispatch)
  ├─────────────────────────┤
  │ model call              │    request.signal           → Anthropic client
  │                         │    (propagated in params)
  ├─────────────────────────┤
  │ tool call (30s)         │    AbortSignal.timeout(30s) → composeSignals
  │                         │    · route signal           →   (first fires wins)
  └─────────────────────────┘
```

**Seams.** Two important ones. First, the route → agent seam:
the route composes the abort signal and hands it to every downstream
layer. Second, the transport seam: `composeSignals(opts?.signal,
AbortSignal.timeout(TOOL_TIMEOUT_MS))` at
`lib/mcp/transport.ts:131,150`. That's the joint where the
per-call timeout and the request-level abort meet — first signal
to fire wins.

## How it works

### Move 1 — the mental model

You already know how a `fetch()` with `AbortController.signal`
cancels early — one signal, one owner, one place it's checked.
This is the same primitive, layered: multiple signals compose, and
each layer both listens to the upstream signal and can create its
own.

```
  Pattern — composed deadline

  outer budget ───────┐
    (route: 300s)      │  fires first
                       ▼
                     ┌──────────────┐
    inner budget ──► │ first-to-fire│ → abort propagates down
    (tool: 30s)      │  wins        │
                     └──────────────┘
                       ▲
    request signal ────┘  (user cancelled)

  three sources of cancel · one AbortSignal contract · every layer honors it
```

The skeleton part everyone forgets: **composition is done at the
transport, not at the caller.** The caller (agent) passes one
signal down; the transport wraps it with its own timeout so both
fire against the same fetch. If composition happened at the agent,
every call site would need to remember to wrap — the transport
seam owns it once.

### Move 2 — walking each budget

#### The route budget — 300s

Set at the top of the route module (`app/api/agent/route.ts:23`).
Vercel's runtime respects it as a hard wall-clock cap:

```ts
// 300s = Vercel Pro's max. A live investigation (diagnostic → recommendation)
// runs ~100-115s under the ~1 req/s MCP limit; 60s (Hobby) cannot fit it.
export const maxDuration = 300;
```

**Why 300 and not less.** The comment names the tradeoff. Baseline
p50 for a full case is ~225s; the 300s cap gives ~75s headroom.
Dropping to 60s would fit ~15% of runs at best.

**Where it's honored inside the route.** Between every coarse
phase, the code re-checks:

```ts
// app/api/agent/route.ts:231, 242, 253, 279, 295
req.signal.throwIfAborted();
```

That's the check that catches a client-cancelled request (user
closed the tab) mid-investigation and lets the `finally` at
`route.ts:322-345` still fire — so the phase log records how much
of the budget was burned before the cancel landed. Important for
the 300s-budget incident signal: even a cancelled run tells you
what phase was expensive.

#### The tool timeout — 30s

Set once at the transport module (`lib/mcp/transport.ts:38`):

```ts
const TOOL_TIMEOUT_MS = 30_000;
```

Composed with the request signal at every fetch call
(`lib/mcp/transport.ts:131,150`):

```ts
const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
```

**`composeSignals` semantics.** Returns a single `AbortSignal` that
fires when EITHER input fires. First-to-fire wins. This is the
load-bearing part: the tool timeout and the route-level cancel
share one contract, so downstream `fetch`/`Anthropic` clients need
only listen to one signal.

**Why the tool timeout is inner, not outer.** A hanging MCP tool
call must not burn the whole 300s. If the tool times out at 30s,
the retry ladder still has room to try again (retryDelayMs=10s,
retryCeilingMs=20s, maxRetries=3 → up to ~60s of retries), and the
outer route budget still has time to run the recommendation phase.
Making the tool timeout too short bricks a slow-but-live tool
call; too long turns any hang into a route timeout.

#### The cost ceiling — $2 per investigation

Set per-investigation by the runner (route or eval), checked
BEFORE every Anthropic call.

Route side (`eval/load.eval.ts:265`):

```ts
const budget = new BudgetTracker({ maxCostUsd: BUDGET_PER_INVESTIGATION_USD });
```

Model-adapter side (`lib/agents/aptkit-adapters.ts:59-66`):

```ts
async complete(request: ModelRequest): Promise<ModelResponse> {
  // Phase-3 budget-ceiling gate: check BEFORE dispatching the API call
  // so a runaway loop can't burn additional cost after the ceiling has
  // already been hit.
  if (this.budget?.exceeded()) {
    throw new BudgetExceededError(this.budget.snapshot(), this.budget.limit);
  }
  // …dispatch anthropic.messages.create(…)
```

**Check BEFORE dispatch.** This is the load-bearing part. If the
check happened after the response, the ceiling would already be
exceeded by the value of one more turn. Checking before means the
next turn is refused — the runaway loop stops before spending. See
`05-budget-ceiling-check-before-dispatch.md` for the full walk.

#### The `finally` that guarantees a log line

```ts
// app/api/agent/route.ts:322-343
} finally {
  try { await disposeDataSource(); } catch (…) { … }
  console.log(JSON.stringify({
    route: '/api/agent',
    sessionId: sid,
    mode,
    totalMs: Math.round(performance.now() - t0),
    phases,
    aborted: req.signal.aborted,
  }));
  controller.close();
}
```

**Why this matters for perf debugging.** A request that blew the
300s budget still emits its phase timings, and Vercel's log query
reads them by phase name. If `diagnostic_investigate` shows 250s
and `recommendation_propose` never fired, you know exactly what
consumed the budget. No log = no signal = no fix.

### Move 3 — the principle

Compose budgets on different axes; don't try to make one budget do
the work of three. Wall clock, per-call latency, and money are
three axes with three failure modes. A single ceiling on any one
would either brick short calls or admit runaway loops on the
others. The composition — outer route budget, inner tool timeout,
sideways cost ceiling — is what makes the deadline actually hold.

## Primary diagram

```
  Composed deadlines, one investigation

  ┌─ time (0 ────────────────────────────────────► 300s) ────────┐
  │                                                                │
  │  0s   phase: schema_bootstrap                                 │
  │        └─ tool_timeout budget → 30s max on this call           │
  │  ~5s  phase: list_tools                                       │
  │  ~5s  phase: diagnostic_investigate (ReAct)                   │
  │        ├─ turn 1: budget.exceeded()? no → dispatch            │
  │        │            ↑ Anthropic call ($$)                     │
  │        ├─ turn 2: budget.exceeded()? no → dispatch            │
  │        ├─ tool: composeSignals(req.signal, timeout(30s))      │
  │        │            ↑ MCP call · retry ladder if 429          │
  │        └─ …                                                    │
  │ ~120s  phase: recommendation_propose                          │
  │ ~220s  send DONE                                              │
  │                                                                │
  │ ▲ req.signal.throwIfAborted() checked between every phase     │
  │ ▲ finally { console.log(phase timings) } fires on any exit    │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where the pattern comes from.** Composed deadlines are standard
in RPC stacks (gRPC has deadline propagation as a first-class
concept: a client deadline becomes a server deadline becomes a
downstream RPC deadline, each recomputed as time-remaining). This
repo lifts the same idea onto HTTP + Anthropic API + MCP transport,
using `AbortSignal` as the vehicle.

**What's slightly different here.** The three budgets aren't
recomputed from a single upstream deadline — each is set
independently. The route budget is a Vercel platform cap; the tool
timeout is a static 30s; the cost ceiling is a per-investigation
dollar number. They share the `AbortSignal` contract but not a
single wall-clock source. That's a simplification that works when
the outer bound (300s) is generous enough that the inner bounds
never need to shrink dynamically.

**Adjacent concept.** `study-runtime-systems` walks the
`AbortSignal` mechanism itself — how `composeSignals` is
implemented, how listeners fire, why a canceled signal doesn't
throw immediately in every callback. This file uses the primitive;
that file explains it.

## Interview defense

### Q1 · "Walk me through how a single hung MCP tool call is bounded."

**Answer.** Three layers of bound. First, the transport composes
`AbortSignal.timeout(30_000)` with the request signal — so any
single `transport.callTool` fetches abort at 30s. Second, the
retry ladder (`BloomreachDataSource`) will retry up to 3 times,
each capped at 20s, so a rate-limited call can spend up to ~60s of
retries. Third, the route's 300s cap plus `throwIfAborted` between
phases means even if the retries land, the outer budget catches an
overall runaway. And the `BudgetTracker` catches the cost
dimension in case retries are burning turns without progress.

```
  ┌─ MCP call ────┐  30s timeout on each attempt
  │  attempt 1    │  → throws
  ├───────────────┤
  │  attempt 2    │  → throws                 } up to 3× 20s cap
  ├───────────────┤
  │  attempt 3    │  → throws                 }
  └───────────────┘
         │
         ▼  bubble up to route
     req.signal.throwIfAborted() between phases
     BudgetTracker.exceeded() before next model turn
```

**One-line anchor.** "Three axes — wall clock (300s), per-call
timeout (30s), cost ($2) — composed via `AbortSignal` at the
transport seam."

### Q2 · "Why not just set the route budget to 60s and let the tool timeout handle the rest?"

**Answer.** Baseline p50 per full case is ~225s (baseline runId
2026-07-03T04-08-28-644Z, 10 cases). 60s cuts off ~85% of runs
before the recommendation phase even starts. The 300s cap comes
from Vercel Pro's limit; the choice is between paying for Pro or
sacrificing feature completeness. The perf comment at
`app/api/agent/route.ts:21-22` names this tradeoff explicitly.

**One-line anchor.** "60s doesn't fit a diagnostic → recommendation
loop under a ~1 req/s MCP limit; 300s does, with ~75s headroom."

### Q3 · "What breaks if you drop the `throwIfAborted` calls between phases?"

**Answer.** A client that cancels mid-run (closed tab) doesn't
know that the server keeps running. Money keeps burning through
the Anthropic calls, the recommendation phase runs to completion,
and nothing shortens the wall clock. The load-bearing part:
`throwIfAborted` is the *bridge* between the outer abort signal
(fired by Vercel/Node when the client cancels) and the phase-level
control flow. Without it, the signal fires but the loop keeps
going.

**One-line anchor.** "Abort signal is inert until someone checks
it; `throwIfAborted` is that check."

## See also

- `02-spacing-gate-and-retry-ladder.md` — how the 60s of retry
  budget is spent inside the tool-timeout window.
- `05-budget-ceiling-check-before-dispatch.md` — the cost axis.
- `study-runtime-systems` — `AbortSignal` composition primitives.
- `study-system-design` — why the route runs on Vercel node
  runtime at all, and what "cold start" means for the budgets.

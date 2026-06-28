# Per-tool circuit breaking

*Industry name: circuit breaker / per-dependency breaker — Industry standard.*

Single-call retry handles one flaky request. An agent loop can call the *same flaky tool* on every turn — retrying a dead tool inside a loop multiplies the failure by the iteration count and burns the whole budget on a tool that isn't coming back. **Not in this repo — the named gap.** This is the most concrete production-serving addition the repo should make.

## Zoom out — where this concept would live

A per-tool breaker lives at the DataSource layer (where the tool calls happen) with hooks into the agent layer (so the open-circuit state can be fed back as an observation). Today there's general retry but no per-tool state.

```
  Where per-tool circuit breaking WOULD live

  ┌─ Agent layer ──────────────────────────────────────────────┐
  │  receives "tool X unavailable" as observation               │ ← would receive
  │  reasoning routes around it (picks different tool / degrades)│   feedback
  └─────────────────────┬──────────────────────────────────────┘
                        ▼
  ┌─ DataSource layer ─────────────────────────────────────────┐
  │  per-tool breaker state: { closed | open | half-open }     │ ← new (this file)
  │  on N consecutive failures: OPEN; fail fast                 │
  │  after T cooldown: HALF-OPEN; try one                       │
  │  + existing: cache, spacing, rate-limit retry               │
  └─────────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **what's the failure cost as the iteration count grows?**

```
  Without per-tool breaker:
  ─────────────────────────
  agent calls tool X → fails (10s timeout)
  agent retries tool X → fails (10s timeout)
  agent retries tool X → fails (10s timeout)
  ...
  6 attempts × 10s = 60s burned on a dead tool
  + full per-agent budget spent, agent returns empty fallback

  With per-tool breaker:
  ──────────────────────
  agent calls tool X → fails (10s)
  breaker counts failures (now 1)
  agent calls tool X → fails (10s)
  breaker counts failures (now 2)
  agent calls tool X → fails → OPEN circuit, fail fast (50ms)
  agent observes "tool X unavailable" → reasons around it
  total burn: 2 × 10s + 50ms × 4 = ~20s; tool budget mostly preserved
```

The breaker turns "the entire iteration budget spent on retries" into "two failed attempts and the agent routes around it."

## How it works

### Move 1 — the mental model

You know the circuit breaker from microservices — Netflix's Hystrix made it famous. State machine with three positions: **closed** (calls pass through), **open** (calls fail fast without hitting the dependency), **half-open** (one trial call to see if the dependency recovered). Per-tool circuit breaking is that primitive scoped to one tool name, not one whole service.

```
  Per-tool circuit breaker — state machine per tool

  ┌─ closed ─────┐  N consecutive  ┌─ open ─────┐  after T  ┌─ half-open ───┐
  │  calls pass  │ ──── fails ────► │ fail fast  │ ──────── ►│  try one call  │
  │  through     │                  │  no actual │ cooldown  │                │
  │              │  any success      │  call      │           │                │
  │              │ ◄──────────────── │            │           │                │
  └──────────────┘                  └────────────┘           └────────┬───────┘
        ▲                                                              │
        │ success                                                      │
        └──────────────────────────────────────────────────────────────┘
                                  back to closed
```

### Move 2 — what it would look like in this repo

The implementation would live in `BloomreachDataSource`, alongside the existing cache and retry. The state shape:

```typescript
// hypothetical addition
type BreakerState = 'closed' | 'open' | 'half-open';
private breakers = new Map<string, {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number;
}>();

private readonly FAILURE_THRESHOLD = 3;
private readonly COOLDOWN_MS = 30_000;
```

The check inside `callTool`:

```typescript
async callTool(name, args, opts) {
  const breaker = this.breakers.get(name) ?? { state: 'closed', consecutiveFailures: 0, openedAt: 0 };
  
  // check breaker state
  if (breaker.state === 'open') {
    if (Date.now() - breaker.openedAt > this.COOLDOWN_MS) {
      breaker.state = 'half-open';
    } else {
      // FAIL FAST — no actual call
      throw new Error(`Tool ${name} unavailable (circuit open)`);
    }
  }

  try {
    const result = await this.actualCall(name, args, opts);
    // success → close circuit
    breaker.state = 'closed';
    breaker.consecutiveFailures = 0;
    this.breakers.set(name, breaker);
    return result;
  } catch (err) {
    breaker.consecutiveFailures++;
    if (breaker.consecutiveFailures >= this.FAILURE_THRESHOLD) {
      breaker.state = 'open';
      breaker.openedAt = Date.now();
    }
    this.breakers.set(name, breaker);
    throw err;
  }
}
```

**The crucial second half: feed the open-circuit state back to the agent.**

In a standard circuit breaker, the breaker just fails fast — protecting *your* service from hammering a broken dependency. For agents, that's not enough. The agent needs to know "this tool is down" so its reasoning can route around it; otherwise the agent keeps trying the dead path and the breaker just fails fast every time, still burning budget on attempts.

The fix: when the breaker is open, the harness should still emit a tool_result block to the model — but with an error message that says "tool X is currently unavailable; try a different approach." The agent's next turn sees this as feedback and can pick a different tool. Sketch:

```typescript
// in runAgentLoop's tool execution path
try {
  result = await dataSource.callTool(name, args, { signal });
} catch (err) {
  // existing path
  isError = true;
  resultContent = JSON.stringify({ error: err.message });
}
// agent sees the error as a tool_result; reasoning can route around
```

The existing `runAgentLoop` already wraps tool errors as `tool_result` blocks with `is_error: true` — so the agent already gets the feedback. The breaker adds *fast failure* (no 10s wait per attempt) and *persistent state* (the breaker stays open across the agent's subsequent turns, so the agent reliably stops trying).

### Move 2.5 — the trade

A per-tool breaker adds state the agent runtime has to carry across turns (which tools are open, their cooldown timers). The state has to be carefully scoped — per-process in the simple case, per-session in the Vercel case (since instances are ephemeral).

The failure this prevents is the expensive one: without it, one dead tool plus an agent loop equals the entire iteration budget spent on retries — the worst kind of cost blowup because it produces nothing. This is the control that turns the "tool-call cascade" failure mode from a budget-ending event into a routed-around inconvenience.

### Move 3 — the principle

The shift from single-call's circuit breaker: there, the breaker protects *your* service from hammering a broken dependency. For agents, it does that AND feeds the open-circuit state back to the agent as an observation, so the agent's reasoning can route around the dead tool rather than looping on it. A breaker that just fails fast without telling the agent leaves the agent retrying the same dead path. The agent-architecture version is **breaker + feedback** — both halves matter.

## In this codebase

**Not implemented.** The current `BloomreachDataSource` has rate-limit retry (handles 429s with backoff) and a 60s response cache, but no per-tool failure tracking. A flaky tool today wastes calls until the per-agent `maxToolCalls` budget is spent (`../01-reasoning-patterns/02-agent-loop-skeleton.md`); the budget exit then forces synthesis with the partial data.

The natural opportunity: when an MCP tool becomes consistently flaky (the Bloomreach alpha server has had real instability — this isn't hypothetical), the agent today burns its whole budget on retries. Adding a per-tool breaker would cut that to 2-3 attempts and let the agent route around the dead tool.

The work:
1. Add breaker state to `BloomreachDataSource` (~50 lines)
2. Test fakes that simulate flaky tools (the `SyntheticDataSource` is the seam — it can already be wired to fail deterministically)
3. Update the agent prompts to encourage "if a tool is unavailable, try a different approach"

## Primary diagram

The contrast — today vs with per-tool breaker:

```
  Comparison — flaky tool with vs without per-tool breaker

  TODAY (no breaker):
  ┌──────────┐ tool X call → fails ┌──────────┐
  │ agent    │ ──────────────────► │ MCP      │ ── 10s timeout
  └──────────┘   (retry, wait, etc)└──────────┘
       │
       ▼ next turn
  ┌──────────┐ tool X call → fails ┌──────────┐
  │ agent    │ ──────────────────► │ MCP      │ ── 10s timeout
  └──────────┘                     └──────────┘
       │
       ▼ ... repeat until maxToolCalls=6 is spent
  total: ~60s burned on a dead tool, agent returns empty fallback

  WITH per-tool breaker:
  ┌──────────┐ tool X call → fails ┌──────────┐
  │ agent    │ ──────────────────► │ breaker  │ → MCP → 10s fail
  └──────────┘                     │ count:1  │
       │                            └──────────┘
       ▼ next turn → fails
  ┌──────────┐                     ┌──────────┐
  │ agent    │ ──────────────────► │ count:2  │ → MCP → 10s fail
  └──────────┘                     └──────────┘
       │                            
       ▼ next turn → breaker OPEN
  ┌──────────┐                     ┌──────────┐
  │ agent    │ ──────────────────► │ OPEN —   │ ── 50ms fail-fast
  │ observes │                     │ fail fast│   "tool X unavailable"
  │ "X dead, │ ◄─────────────────  │          │
  │  use Y"  │                     └──────────┘
  └──────────┘
       │
       ▼ next turn — agent calls tool Y instead
  ┌──────────┐ tool Y call → succeeds
  │ agent    │ ──────────────────► [happy path]
  └──────────┘

  total: ~20s + agent successfully routes around the dead tool
```

## Interview defense

**Q: "How do you handle a flaky tool in an agent loop?"**

A: Today, badly — the agent retries the flaky tool every turn until the `maxToolCalls` budget is spent (6 attempts × 10s timeout = 60s burned on a dead tool, agent returns empty fallback). The named gap in this repo. The fix is a per-tool circuit breaker at the DataSource layer: state machine per tool name (closed / open / half-open), N consecutive failures opens the circuit, T-second cooldown half-opens it, success closes it. The crucial second half is feeding the open-circuit state back to the agent as a tool_result error so the agent's reasoning can route around it. A breaker that just fails fast without telling the agent leaves the agent retrying the same dead path — the agent-architecture version is **breaker + feedback**, both halves matter.

Implementation is ~50 lines in `BloomreachDataSource`, and the test seam already exists — `SyntheticDataSource` can be wired to fail deterministically, so the breaker can be tested without touching real Bloomreach. The work the team hasn't done is just prioritization — the Bloomreach alpha server's instability has caused real burn, but the per-agent budget caps a single bad run, so the issue surfaces as "users see a fallback" rather than "users see a runaway." A breaker would make the failure mode "users see degraded output but the agent stays in budget."

Diagram I'd sketch:

```
  ┌─ closed ─┐ N fails ┌─ open ─┐  T  ┌─ half-open ─┐
  │ pass thru│ ──────► │fail fast│ ──► │ try one      │
  └──────────┘         └─────────┘     └──────┬──────┘
       ▲                                       │
       │ success                               │
       └───────────────────────────────────────┘

  + critical: agent receives tool_result with error so reasoning routes around
```

Anchor: "without the breaker, one flaky tool burns the whole 6-call budget on retries — the worst kind of cost blowup because it produces nothing. With it, the budget is mostly preserved and the agent can degrade gracefully."

**Q: "What state lifetime would the breaker use?"**

A: Per-process in the simple version (the breakers Map lives on the DataSource instance, which is per-request on Vercel). That means each new request starts with a fresh breaker — a tool that's been failing for 10 minutes still gets retried on the next request. The honest tradeoff: Vercel's ephemeral instance lifecycle makes per-session breaker state hard; the right answer is either an external store (Redis, Postgres) or accepting per-request fresh state. For this repo's traffic volume, per-request fresh state is probably acceptable — the breaker still saves the current request from the full budget burn, even if it doesn't persist across requests. If usage grew, an external breaker store would be the next investment.

## See also

- [`../01-reasoning-patterns/02-agent-loop-skeleton.md`](../01-reasoning-patterns/02-agent-loop-skeleton.md) — the kernel where the budget exit fires (without breaker, this fires after the full 6-call burn)
- [`../03-multi-agent-orchestration/09-coordination-failure-modes.md`](../03-multi-agent-orchestration/09-coordination-failure-modes.md) — tool-call cascade is exactly what this prevents
- [`02-fan-out-backpressure.md`](./02-fan-out-backpressure.md) — the sibling flow-control primitive at the same layer
- [`../04-agent-infrastructure/05-guardrails-and-control.md`](../04-agent-infrastructure/05-guardrails-and-control.md) — this is the named gap in the control envelope
- ai-engineering's circuit-breaker file (cross-ref) — the single-call version of the same primitive

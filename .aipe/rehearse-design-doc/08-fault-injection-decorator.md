# RFC-08 — Fault-injection DataSource decorator

**Decision in one line:** Wrap the DataSource port with a decorator (`FaultInjectingDataSource`) that forces per-call failures — timeouts, 429s, 500s, malformed JSON — at configurable rates with a seeded PRNG. The tier-2 receipt is real: **9 injected faults / 3 investigations / 0 failed runs**, because AptKit surfaces every fault as a `tool_result is_error:true` block that the model reasons around.

---

## Context

The "shows its work" pitch has an implicit promise: when things go wrong, the user sees them go wrong gracefully. That's a claim about behavior under fault. Defending it needs a receipt — a repeatable test where injected faults happen, the agents deal with them, and the investigation still concludes.

Real Bloomreach is the wrong test surface:

- **Non-reproducible.** The alpha server times out sometimes, 429s sometimes, drops connections sometimes. You can't schedule those to happen during a specific eval case.
- **Expensive.** Each test call spends real tokens and hits real rate limits.
- **Slow.** ~1 req/s is the throttle; a fault suite of 20+ cases would take minutes to run just from the rate limit.
- **Not actually stressed.** Bloomreach's error surface is a fraction of what a production LLM app has to handle. Malformed JSON, half-written tool results, timeout mid-stream — those either happen rarely or don't happen at all in the alpha.

The seam already exists (RFC-05: DataSource port with three prior adapters shipped). The question was whether fault injection is another adapter (a swap) or a decorator (a wrap). Wrap won, because the goal is to make the *real* stack fail in known ways — not to substitute a fake stack that fails.

---

## Decision

Build `FaultInjectingDataSource` at `lib/data-source/fault-injecting.ts`. It implements `DataSource` (so it plugs in wherever the seam is expected) and takes another `DataSource` as a constructor argument (so it wraps whatever concrete adapter is behind it — Bloomreach or Synthetic). Four fault modes, each with an independent probability:

```
The four fault modes — mimicking Bloomreach's real error shapes

  ┌─ mode ─────────┬─ what it throws / returns ─────────────────────┐
  │ timeout        │ throw Error("HTTP 0: timeout after 30000ms")   │
  │                │ (shape from lib/mcp/transport.ts:137)           │
  ├────────────────┼────────────────────────────────────────────────┤
  │ rate_limit     │ throw Error("Rate limited: retry after 2000ms")│
  │                │ + err.status = 429                              │
  │                │ (shape from BloomreachDataSource retry ladder)  │
  ├────────────────┼────────────────────────────────────────────────┤
  │ server_error   │ throw Error("HTTP 500: Internal server error") │
  │                │ + err.status = 500                              │
  ├────────────────┼────────────────────────────────────────────────┤
  │ malformed_json │ returns a ToolResult with broken content:      │
  │                │   { content: [{type: 'text',                    │
  │                │      text: '{"broken":"unclosed' }] }           │
  │                │ (non-throwing — exercises downstream JSON parse)│
  └────────────────┴────────────────────────────────────────────────┘
```

Reproducibility is deliberate: the PRNG is xorshift32 when `seed` is set (so a fault sequence replays byte-for-byte across runs) and falls back to `Math.random()` when it isn't (for looser exploratory testing). Faults are only injected on `callTool` — `listTools` stays clean so the agent's bootstrap phase isn't a randomly failing path.

**The receipt — this is what makes the decision defensible, not aspirational:**

Over the tier-2 fault-injection run:
- **9 injected faults** across 3 investigations
- **0 failed runs** — every investigation reached a concluded diagnosis

The reason isn't luck; it's the shape of the loop. AptKit's ReAct loop packages every tool failure as a `tool_result` block with `is_error: true`. The model sees the error, reasons about it in the next turn, and typically retries or falls back to a different tool. The graceful degradation isn't a Blooming feature — it's what the ReAct pattern gives you when the tool interface honestly reports errors.

---

## Alternatives considered

**(a) Chaos-monkey style outside the process.** Kill sockets from a sidecar or a proxy. Loses because it's a lot of infrastructure to test the code path that's already reachable from within the process via a decorator. The infra approach makes sense at horizontal scale; at one Vercel function it's overkill.

**(b) Integration tests against real Bloomreach.** Rely on the alpha's natural failure rate. Loses on all four dimensions from the Context section — non-reproducible, expensive, slow, undersampled. You can't build a receipt out of a system you can't schedule.

**(c) Mocking at the Anthropic SDK layer.** Mock `messages.create` to sometimes return a broken response. Loses because that's the wrong axis. The interesting faults are on the tool-execution side (which Bloomreach owns), not the model side. Mocking Anthropic tests "what if the model fails," which is a different failure story.

**(d) Add fault injection to the concrete BloomreachDataSource.** Bake `if (Math.random() < 0.05) throw ...` into the real adapter. Loses on separation-of-concerns and on production safety — you don't want a rate knob in production that can turn on faults by accident. A decorator makes the fault injection lexically separate: it's only present in the harness that constructs it.

---

## Consequences

**What this buys:**
- **A receipt, not a claim.** 9/3/0 is a specific number from a specific run. When a reviewer asks "how do you know graceful degradation works?", the answer is a runId with 9 injected faults and 3 clean conclusions.
- **The seam paid for itself again.** Fault injection was the fourth use of the DataSource port (Olist add → Olist remove → Synthetic add → FaultInjecting). Each use is a receipt that the abstraction is real — a port people actually reuse is a healthy port.
- **Reproducible fault sequences.** With `seed`, the same fault pattern replays across CI runs. Fault-related regressions surface as different verdicts on the same fault trace — not as flaky noise.
- **The graceful path is the ReAct path.** No special error-handling code path was written. The loop already knew what to do with `is_error: true` blocks. Fault injection uncovered a capability that was already there, just untested.

**What it costs:**
- **Independent per-call probabilities are a simplification.** Real outages are bursty — the alpha server doesn't fail one call in 100 randomly; it fails 20 calls in a row when it's degraded. The current model doesn't capture correlated bursts. Passing the fault suite tells you the agent recovers from *isolated* faults, not from a sustained outage.
- **Only `callTool` is faulted.** Streaming faults, WS-level faults, auth revocation mid-stream — none of those go through this decorator. Documented gap.
- **The onFault callback is optional.** If callers don't wire it up, faults happen silently in the trace. The eval harness wires it; ad-hoc runs might not. Not a functional issue but a "watch out" for new consumers.

**What the reviewer will push on:**
> "Independent per-call faults isn't real chaos. Real outages are correlated."

Own it — and this is the most reconsiderable open question in the whole book. The framing that holds: "You're right, this doesn't capture bursty failures. What it *does* capture is that the agent recovers from isolated faults through the ReAct is_error path — which was the tier-2 unknown. Bursty correlation is the tier-3 story; the fix is a Markov-chain state (`healthy` → `degraded` → `healthy`) driving the fault selector. Not built yet because tier-2 was the current commitment."

That's the reviewer question you're most likely to hear on this book, and the answer above is the one to have ready.

---

## Open questions

- **Correlated fault bursts (Markov states).** Add a two-state model where `degraded` inflates all fault probabilities for N consecutive calls, then transitions back. This is the most reconsiderable open question in the RFC — reviewers will push on it. Solvable, deliberately deferred.
- **WS / streaming faults.** The alpha's SSE-style streaming can drop mid-message. The current decorator can't produce this because it lives at the `callTool` boundary, after the network reply is assembled. Would need a lower-level transport-side decorator.
- **Fault-aware verdicts in the regression gate.** Should a case that concludes via graceful degradation score identically to a case that concludes on the happy path? Today: yes. Arguably a "concluded despite N faults" case is *better* signal than a clean case — worth a separate dimension in the rubric.
- **Auth revocation mid-flight.** Bloomreach's alpha revokes tokens after minutes; the fault decorator can't simulate this today because it's not really a callTool failure — it's an auth-state transition. Left as a separate fault story.

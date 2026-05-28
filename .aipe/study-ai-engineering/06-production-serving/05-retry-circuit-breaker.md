# Retry + circuit breaker

**Industry name(s):** bounded retry, exponential backoff with jitter, circuit breaker (closed/open/half-open), fail-fast
**Type:** Industry standard · Language-agnostic

> `McpClient.callTool` retries a rate-limited call up to `maxRetries = 3` times with a FIXED `retryDelayMs = 1200` pause — bounded and correct, but a fixed delay (not exponential backoff with jitter) — and there is no circuit breaker, so during a sustained provider outage every call still runs the full retry sequence before failing.

**See also:** → 04-rate-limiting-backpressure.md · → 01-llm-caching.md · → ../04-agents-and-tool-use/README.md

---

## Why care

A `fetch` fails with a transient 503. You wrap it in a retry loop: try, and if it fails, wait and try again, a bounded number of times. Most transient failures clear on the second attempt, so the retry turns a flaky call into a reliable one — and the bound stops a permanently-broken upstream from looping forever.

Retry handles the *transient* failure: the blip that clears on its own. But it has a dark side. When the upstream is not blipping but *down* — a sustained outage — every single call still pays the full retry sequence (wait, try, wait, try…) before giving up. Multiply that across many callers and you have made the outage worse: a flood of retrying clients hammering a dying service. The question this concept answers is: *how do you retry transient failures without amplifying a real outage?*

**The answer needs two mechanisms, and blooming insights has only the first.** Retry recovers from blips. A **circuit breaker** detects sustained failure and *stops calling* — failing fast for a cooldown window instead of paying the retry tax on every request. blooming insights retries rate-limit errors with a bounded loop, which is correct, but the delay is fixed (not exponential with jitter, so concurrent retries can synchronize into a thundering herd), and there is no breaker, so a Bloomreach outage means every call grinds through its full retry sequence before failing.

Before naming the mechanisms:
- A rate-limit 429 kills the agent run on the first hit
- A transient blip is indistinguishable from a hard failure
- A provider outage makes every call wait, try, wait, try, then fail — slowly

After what `callTool` provides (and what it doesn't):
- A 429-equivalent triggers a bounded retry loop (up to 3 retries)
- A fixed 1200 ms pause separates attempts
- BUT the delay does not grow (no backoff) or randomize (no jitter)
- AND there is no breaker — during an outage, every call pays the full retry tax

It is the `fetch`-retry pattern, bounded and correct — missing the backoff-with-jitter refinement and the fail-fast breaker.

---

## How it works

**Mental model.** Failure handling has two layers that answer different questions. **Retry** answers "this failed — should I try again?" and is right when the failure is transient. **Circuit breaker** answers "is the upstream healthy enough to call at all?" and is right when the failure is sustained — it trips after repeated failures and fails fast (no call, no retry) until a cooldown passes. Retry without a breaker amplifies outages; a breaker without retry is brittle to blips. You want both.

```
 retry (built)                       circuit breaker (absent)
 ──────────────────────────         ────────────────────────────────
 "try again?"                        "should I call at all?"
 right for transient blips           right for sustained outages
 bounded loop + delay                trip after N failures → fail fast
 amplifies a real outage             stops the retry flood during outage
```

The gap: blooming insights' retry loop is correct for a blip but, with no breaker, turns a sustained Bloomreach outage into N callers each grinding through 3 retries before failing — exactly the amplification a breaker prevents.

---

### Bounded rate-limit retry (`callTool`)

After the first live call, `callTool` checks whether the result is a rate-limit error and, if so, retries up to a bound, sleeping between attempts.

```
 callTool:                                       lib/mcp/client.ts
   result = liveCall(name, args)                 L46
   retries = 0
   while isRateLimited(result) && retries < maxRetries:   L49
     retries++                                   L50
     await sleep(retryDelayMs)                   L51   ← FIXED 1200ms
     result = liveCall(name, args)               L52
```

The loop is at `lib/mcp/client.ts` L49–L53. `isRateLimited` (L7–L11) returns true only when the result has `isError: true` and its text matches `/rate limit|too many requests/i` — so the retry targets exactly the recoverable case, not every error. `maxRetries = 3` (`lib/mcp/client.ts` L26) bounds the loop; `retryDelayMs = 1200` (L27) is the pause between attempts. Each retry re-enters `liveCall`, which re-applies the 1100 ms spacing gate (see `04-rate-limiting-backpressure.md`), so a retry never violates the rate limit.

```
  liveCall → result
     │
  isRateLimited?
   ┌─ no  → continue (cache / return)
   └─ yes → retries < 3 ?
              ┌─ no  → return the error (exhausted)
              └─ yes → sleep(1200) → liveCall again ─┐
                                                     └─ loop
```

Total attempts: 1 initial + up to 3 retries = 4 calls. The retry is bounded (no infinite loop) and targeted (only 429-equivalents) — both correct.

---

### The honest limitation — fixed delay, not exponential backoff with jitter

The pause between attempts is a constant 1200 ms. It does not grow with each retry, and it does not add randomness.

```
 FIXED (current):                    EXPONENTIAL + JITTER (standard):
 attempt 1 → fail                    attempt 1 → fail
   wait 1200                           wait ~1000 ± rand
 attempt 2 → fail                    attempt 2 → fail
   wait 1200                           wait ~2000 ± rand
 attempt 3 → fail                    attempt 3 → fail
   wait 1200                           wait ~4000 ± rand
 attempt 4                           attempt 4
```

Two consequences. First, **no backoff**: a fixed delay does not give a struggling upstream progressively more room to recover — exponential growth (1s, 2s, 4s) backs off harder as failures persist. Second, **no jitter**: if many callers all hit a 429 at the same moment and all sleep exactly 1200 ms, they all wake and retry *simultaneously* — a synchronized burst (thundering herd) that can re-trigger the same rate limit. Jitter (randomizing each delay) desynchronizes them. The `connect.ts` comment (L51–L55) explicitly flags backoff as a Phase 2 follow-up — this is a known, documented limitation, not an oversight.

---

### The bigger gap — no circuit breaker

The retry loop assumes the failure is transient. During a *sustained* Bloomreach outage, that assumption is false, and the loop becomes a liability: every `callTool` runs its full 4-attempt sequence (≈ 1100 + 1200×3 ≈ 4700 ms of waiting) before failing — for every call, of every agent, of every run.

```
 NO BREAKER (current):
   outage begins
   call 1: try, wait, try, wait, try, wait, try → FAIL  (~4.7s wasted)
   call 2: try, wait, try, wait, try, wait, try → FAIL  (~4.7s wasted)
   ...     every call pays the full retry tax, hammering a dead service

 WITH BREAKER (absent):
   call 1..N: failures accumulate → breaker TRIPS (open)
   call N+1..: fail INSTANTLY (no call, no retry) for cooldown
   after cooldown: half-open → one probe → close if it succeeds
```

A circuit breaker tracks recent failures. After a threshold of consecutive failures it **opens** — subsequent calls fail immediately without touching the network or the retry loop. After a cooldown it goes **half-open**, letting one probe through; success **closes** it (resume normal calls), failure re-opens it. This converts a slow, repeated, amplifying failure into a fast, cheap one — and stops the retry flood from worsening the outage. blooming insights has none of this: there is no failure counter, no open/closed state, no fast-fail path.

---

### Current state vs future state

```
            built                          absent
            ──────────────────────         ────────────────────────────
retry       bounded loop (maxRetries 3)     —
            targeted (isRateLimited)
delay       fixed 1200ms                    exponential backoff
jitter      —                              randomized delay (anti-herd)
breaker     —                              open/half-open/closed + cooldown
fail-fast   —                              instant fail during outage
```

Two refinements and one new mechanism are missing: backoff (grow the delay), jitter (randomize it), and a circuit breaker (fail fast during sustained outage). The retry foundation is sound; these harden it.

---

### The principle

Retry recovers from transient failure; a circuit breaker protects against sustained failure — and a flood of retries without a breaker amplifies an outage instead of surviving it. The bounded, targeted retry blooming insights built is the correct foundation. The refinements (exponential backoff to back off harder, jitter to desynchronize) and the breaker (to fail fast and stop hammering a dead upstream) are what turn a retry that *works for a blip* into one that *survives an outage*. The lesson generalizes: every retry loop needs a bound, and every bounded retry that runs at scale needs a breaker in front of it.

---

## Retry + circuit breaker — diagram

This diagram spans the Agent, Service, and Provider layers. The retry loop is built (solid); backoff/jitter and the breaker are the gaps (dashed).

```
  ┌────────────────────────────────────────────────────────────────────┐
  │  AGENT LAYER   lib/agents/base.ts                                    │
  │  mcp.callTool(name, args)   L144                                     │
  └───────┼──────────────────────────────────────────────────────────────┘
          │
  ┌───────▼──────────────────────────────────────────────────────────────┐
  │  SERVICE LAYER   lib/mcp/client.ts                                    │
  │                                                                       │
  │  ╎ BREAKER  (ABSENT): if open → fail fast, skip call entirely ╎       │
  │       │ (no breaker today)                                            │
  │  ┌────▼─────────────────────────────────────────────┐               │
  │  │  result = liveCall   L46  (applies 1100ms spacing) │               │
  │  └────┬─────────────────────────────────────────────┘               │
  │       │                                                               │
  │  ┌────▼─────────────────────────────────────────────┐               │
  │  │  Retry loop  (BUILT)                               │               │
  │  │  while isRateLimited(result) && retries < 3:  L49 │               │
  │  │    retries++                                  L50  │               │
  │  │    sleep(1200)  ── FIXED, no backoff/jitter   L51  │               │
  │  │    result = liveCall                          L52  │               │
  │  └────┬─────────────────────────────────────────────┘               │
  │       │ isRateLimited test: isError && /rate limit/i   L7–L11        │
  │       │ maxRetries=3 L26, retryDelayMs=1200 L27                       │
  └───────┼──────────────────────────────────────────────────────────────┘
          │  NETWORK / PROVIDER BOUNDARY
  ┌───────▼──────────────────────────────────────────────────────────────┐
  │  PROVIDER   Bloomreach MCP server                                     │
  │  transient 429 → retry recovers                                       │
  │  sustained outage → every call pays full retry tax (no breaker)       │
  └───────────────────────────────────────────────────────────────────────┘
```

A reader who sees only this diagram should grasp: bounded retry on 429 is built with a fixed delay; backoff, jitter, and a fail-fast breaker are the missing hardening.

---

## In this codebase

Partially implemented — bounded rate-limit retry is built; backoff/jitter and a circuit breaker are not.

### Bounded rate-limit retry (Case A)

**File:** `lib/mcp/client.ts`
**Function / class:** `McpClient.callTool` retry loop
**Line range:** L49–L53 (loop), with `isRateLimited` at L7–L11. Constants `maxRetries = 3` at L26 and `retryDelayMs = 1200` at L27 (constructor). The loop re-enters `liveCall` (L69–L77), which re-applies the 1100 ms spacing.

Honest note: `retryDelayMs` is a **fixed** delay — the loop sleeps the same 1200 ms on every attempt (L51). There is no exponential growth and no jitter. The `connect.ts` comment at L51–L55 documents backoff as a Phase 2 follow-up.

### Circuit breaker (Case B — Not yet implemented)

**Not yet implemented.** blooming insights has a bounded rate-limit retry but no circuit breaker — there is no failure counter, no open/closed state, and no fast-fail path, so during a sustained Bloomreach outage every `callTool` runs its full retry sequence (~4.7s of waiting) before failing.

Where it would live: a breaker would wrap the retry loop in `McpClient.callTool` (`lib/mcp/client.ts` L46–L53), tracking consecutive failures in instance state alongside `lastCallAt` (L19). When the count crosses a threshold the breaker opens — `callTool` returns a fast failure before `liveCall` (L46) — and a timestamp-based cooldown transitions it to half-open for a single probe. Exponential backoff + jitter would replace the fixed `sleep(this.retryDelayMs)` at L51 with a growing, randomized delay.

---

## Elaborate

### Where this pattern comes from

**Bounded retry** is the standard recovery for transient failures, formalized in distributed-systems literature decades ago: most transient faults clear on a second attempt, and a bound prevents an infinite loop against a permanently-broken upstream. **Exponential backoff** (double the delay each attempt) and **jitter** (randomize it) were popularized by AWS's "Exponential Backoff And Jitter" (2015), which showed that synchronized retries create a thundering herd and that jitter dramatically reduces contention. **The circuit breaker** was named by Michael Nygard in *Release It!* (2007) — borrowed from electrical breakers, it trips to protect a failing downstream from a flood of doomed requests, with closed/open/half-open states and a cooldown.

### The deeper principle

```
  failure type        right mechanism            blooming insights
  ─────────────────   ────────────────────────   ─────────────────────
  transient blip      bounded retry + backoff     retry yes, backoff no
  concurrent retries  jitter (desynchronize)      ABSENT (fixed delay)
  sustained outage    circuit breaker (fail fast)  ABSENT
```

Retry and circuit breaker are complements, not alternatives. Retry assumes the failure is temporary and worth re-attempting; the breaker recognizes when that assumption has broken and stops re-attempting. A system with retry but no breaker handles blips and amplifies outages — which is precisely where blooming insights sits.

### Where this breaks down

The fixed delay creates a thundering herd: if an agent fires several tool calls that all 429 at once and all sleep exactly 1200 ms, they all retry in lockstep and can re-trigger the limit. Without backoff, the delay never grows to give a struggling upstream more room. Without a breaker, a Bloomreach outage means every call across every agent pays ~4.7s of retry waiting before failing — and within the `maxDuration = 60` route budget (`app/api/agent/route.ts` L18), a few such calls consume the entire request window, so the run times out mid-stream instead of failing fast with a clear error.

### What to explore next

- `p-retry` — bounded retry with exponential backoff, jitter, and a custom `shouldRetry` predicate; a drop-in for the `while (isRateLimited)` loop
- `cockatiel` / `opossum` — resilience libraries providing a full circuit breaker (states, thresholds, cooldown) plus retry and timeout
- Decorrelated jitter — AWS's recommended jitter variant that bounds growth while fully randomizing
- Bulkheads + timeouts — the sibling resilience patterns that pair with retry and breaker for full fault isolation

---

## Tradeoffs

| Dimension | This codebase (fixed bounded retry) | Add backoff + jitter | Add circuit breaker |
|---|---|---|---|
| Transient blip | recovers (up to 3 retries) | recovers, backs off harder | recovers (breaker stays closed) |
| Concurrent retry herd | synchronized (all wait 1200ms) | desynchronized by jitter | reduced — breaker may open |
| Sustained outage | every call pays ~4.7s tax | same — backoff doesn't fail fast | fails fast after trip — cheap |
| Setup complexity | done — one while loop | low — growing/random delay | medium — state machine + cooldown |
| Failure mode | outage amplification, run timeout | reduced herd, still slow on outage | fast fail, clear error |

**What we gave up.** The fixed delay gave up two things: backoff (the delay never grows to relieve a struggling upstream) and jitter (concurrent retries stay synchronized into a herd). The absence of a breaker gave up fast-fail behavior during a sustained outage — every call grinds through its full retry sequence, and a few such calls can exhaust the 60s route budget so the run times out instead of failing cleanly. For a single-user demo where Bloomreach outages are rare and concurrency is low, that was a defensible trade — the retry handles the common case (a transient 429) correctly, and the outage case is rare enough that the amplification has not bitten.

**What the alternative would have cost.** Backoff + jitter is cheap (`p-retry` is a drop-in) — the only "cost" is a dependency or a few lines of delay math. The circuit breaker costs more: a small state machine (failure counter, open/closed/half-open, cooldown timer) living in instance state, plus tuning the failure threshold and cooldown duration. For a low-traffic, single-user tool, that state machine is more apparatus than the current failure rate justifies — which is why it was deferred, not built.

**The breakpoint.** The fixed bounded retry is sufficient while Bloomreach outages are rare and traffic is single-user. It breaks when either changes: under concurrency, the synchronized fixed-delay retries form a herd (jitter becomes necessary), and during a sustained outage at any traffic level, the per-call retry tax exhausts the route budget and amplifies the outage (the breaker becomes necessary). The trigger is the first real provider outage observed under load — at that point the breaker moves from "nice to have" to "required."

---

## Tech reference (industry pairing)

### bounded retry

- **Codebase uses:** `while (isRateLimited(result) && retries < this.maxRetries)` (`lib/mcp/client.ts` L49–L53), `maxRetries = 3` (L26).
- **Why it's here:** turns a transient 429 into a recovered call without looping forever.
- **Leading today:** `p-retry` (adoption-leading promise retry, 2026); AWS SDK v3 built-in retry (innovation-leading reference, 2026).
- **Why it leads:** `p-retry` adds backoff, jitter, and `shouldRetry` predicates; AWS SDK ships the reference backoff-with-jitter implementation.
- **Runner-up:** `fetch-retry` for a zero-dependency `fetch` wrapper.

### exponential backoff + jitter

- **Codebase uses:** nothing — a fixed `sleep(retryDelayMs)` of 1200 ms (`lib/mcp/client.ts` L51), no growth, no randomization.
- **Why it's here:** the named limitation; fixed delays synchronize concurrent retries into a herd.
- **Leading today:** AWS decorrelated jitter (adoption-leading, 2026); `p-retry` / `exponential-backoff` (innovation-leading libraries, 2026).
- **Why it leads:** growing delays relieve a struggling upstream; jitter desynchronizes concurrent retries.
- **Runner-up:** full jitter (`random(0, base·2^attempt)`) — simplest effective variant.

### circuit breaker

- **Codebase uses:** nothing — no failure counter, no open/closed state, no fast-fail path.
- **Why it's here:** the missing mechanism; a sustained outage makes every call pay the full retry tax.
- **Leading today:** `opossum` (adoption-leading Node circuit breaker, 2026); `cockatiel` (innovation-leading combined retry+breaker+timeout, 2026).
- **Why it leads:** `opossum` is a focused breaker with metrics; `cockatiel` composes breaker, retry, timeout, and fallback into one policy.
- **Runner-up:** a hand-rolled counter + timestamp state machine in `McpClient`.

---

## Project exercises

### Exponential backoff + jitter and a fail-fast circuit breaker

- **Exercise ID:** B5.4 (adapted) — provenance C5.5 (retry / circuit-breaker).
- **What to build:** Replace the fixed `sleep(retryDelayMs)` in the retry loop with exponential backoff plus jitter (e.g. `base · 2^attempt ± random`), and add a circuit breaker around `callTool`: track consecutive failures, **open** the breaker after a threshold (subsequent calls fail fast without touching the network or the retry loop), transition to **half-open** after a cooldown for a single probe, and **close** on a successful probe.
- **Why it earns its place:** it demonstrates the full resilience pair — retry that does not herd, plus a breaker that fails fast during an outage — the senior signal that you know retry alone amplifies outages.
- **Files to touch:** `lib/mcp/client.ts` (replace the fixed delay at L51; wrap the retry loop L46–L53 with breaker state alongside `lastCallAt` at L19), `test/mcp/client.test.ts` (extend the retry tests: assert growing/jittered delays, and that the breaker opens after N failures and fails fast).
- **Done when:** retries use a growing, randomized delay; after the failure threshold the breaker opens and subsequent `callTool` calls return a fast failure without calling `liveCall`; after the cooldown a single probe can close it — all verified by tests against a fake transport that fails on demand.
- **Estimated effort:** 1–2 days.

### Retry transient 5xx, not just rate limits

- **Exercise ID:** C5.5 (retry) — fresh, no clean Build map.
- **What to build:** Broaden the retry predicate beyond `isRateLimited` to also retry transient server errors (5xx-equivalent results), while keeping non-retryable errors (bad query, 4xx) failing immediately — so the retry targets the full transient class, not only 429s.
- **Why it earns its place:** shows you can distinguish retryable from non-retryable failures, the judgment that prevents both under- and over-retrying.
- **Files to touch:** `lib/mcp/client.ts` (`isRateLimited` at L7–L11 generalized to an `isRetryable` predicate; the loop condition at L49).
- **Done when:** a transient server-error result is retried and a non-retryable client error is not — verified by tests with a fake transport returning each error class.
- **Estimated effort:** <1hr.

---

## Summary

blooming insights retries a rate-limited MCP call up to `maxRetries = 3` times with a fixed `retryDelayMs = 1200` pause (`lib/mcp/client.ts` L49–L53), targeting exactly the recoverable case via `isRateLimited` (L7–L11) and re-applying the 1100 ms spacing on each retry. The retry is bounded and targeted — a correct foundation — but the delay is fixed: no exponential backoff (it never backs off harder) and no jitter (concurrent retries synchronize into a herd). There is no circuit breaker, so a sustained Bloomreach outage makes every call pay its full ~4.7s retry sequence before failing, amplifying the outage and risking the 60s route budget. The buildable target is backoff + jitter plus a fail-fast breaker.

**Key points:**
- Retry recovers from transient blips; a circuit breaker protects against sustained outages — they are complements.
- The retry loop is bounded (`maxRetries = 3`, L26) and targeted (`isRateLimited`, L7–L11) — correct for a 429.
- The delay is fixed at 1200 ms (L51): no backoff (never grows) and no jitter (concurrent retries herd).
- There is no breaker — during an outage every call pays the full retry tax and can exhaust the 60s route budget.
- The fix is exponential backoff + jitter plus an open/half-open/closed breaker that fails fast.

---

## Interview defense

### What an interviewer is really asking

"How do you handle a failing upstream?" tests whether you know retry alone is insufficient — that without a breaker, retries amplify an outage. The weak answer is "I retry with backoff." The strong answer pairs bounded retry (for blips) with a circuit breaker (for sustained failure) and explains why a fixed delay herds while jitter does not.

### Likely questions

**[mid] When does `callTool` retry, and how many times?**

Only when `isRateLimited(result)` is true — `isError: true` and the text matches `/rate limit|too many requests/i` (`lib/mcp/client.ts` L7–L11). Up to `maxRetries = 3` times (L26), sleeping `retryDelayMs = 1200` (L27) between attempts. Total: 1 initial + 3 retries = 4 calls.

```
  liveCall → 429 → sleep 1200 → liveCall → 429 → ... → exhaust → return error
            (max 4 attempts)
```

**[senior] What's wrong with a fixed 1200 ms retry delay?**

No backoff (the delay never grows to relieve a struggling upstream) and no jitter. If several calls 429 at once and all sleep exactly 1200 ms, they all retry simultaneously — a thundering herd that re-triggers the limit. Exponential backoff + jitter (1s, 2s, 4s ± random) backs off harder and desynchronizes.

```
  fixed:  all wake at +1200 → synchronized retry burst
  jitter: wake at +1200±rand → spread out, no herd
```

**[arch] Bloomreach is down for 10 minutes. What does your retry loop do, and what should happen instead?**

Every `callTool` runs its full 4-attempt sequence (~4.7s of waiting) before failing — for every call, amplifying the outage and exhausting the 60s route budget. A circuit breaker should trip after N failures and fail fast (no call, no retry) until a cooldown, then half-open for one probe.

```
  no breaker: call → ~4.7s → fail, repeat for every call
  breaker:    N fails → OPEN → fail instantly → cooldown → half-open probe
```

### The question candidates always dodge

**"Isn't retry enough? Why add a circuit breaker?"**

No — and conflating them is the tell. Retry assumes the failure is transient; during a real outage that assumption is false and retry *amplifies* the problem (every caller hammering a dead service through its full retry sequence). The breaker is the mechanism that detects "this is not transient" and stops retrying — failing fast and giving the upstream room to recover. Retry handles the blip; the breaker handles the outage; you need both.

### One-line anchors

- `lib/mcp/client.ts` L49–L53 — bounded rate-limit retry loop
- `lib/mcp/client.ts` L7–L11 — `isRateLimited`, the targeted retry predicate
- `lib/mcp/client.ts` L26–L27 — `maxRetries = 3`, `retryDelayMs = 1200` (fixed)
- `lib/mcp/client.ts` L51 — the fixed `sleep` (no backoff, no jitter)
- `lib/mcp/connect.ts` L51–L55 — comment flagging backoff as a Phase 2 follow-up

---

## Validate

### Level 1 — Reconstruct

From memory, write the retry loop's three moving parts (the predicate that decides retryability, the bound, the delay). Then state the two refinements the delay lacks (backoff, jitter) and the one mechanism that is entirely absent (circuit breaker), with what each protects against.

### Level 2 — Explain

Out loud: explain why a fixed retry delay creates a thundering herd under concurrency and how jitter fixes it. Then explain why retry without a circuit breaker *amplifies* a sustained outage rather than surviving it.

### Level 3 — Apply

Scenario: Bloomreach is down and investigations are timing out instead of failing cleanly. Open `lib/mcp/client.ts` L49–L53 and `app/api/agent/route.ts` L18. Calculate the worst-case wait for a single `callTool` (initial 1100 ms spacing + 3 × 1200 ms retries) and explain how a few such calls exhaust the 60s `maxDuration` budget. Then state where a breaker would short-circuit this (before `liveCall` at L46).

### Level 4 — Defend

A teammate says "the bounded retry is fine, we don't need a circuit breaker." Defend the breaker: cite the worst-case per-call retry tax (`lib/mcp/client.ts` L49–L53), explain how it amplifies an outage and threatens the 60s route budget (`app/api/agent/route.ts` L18), and name what the breaker adds that retry cannot — a fast-fail path during sustained failure.

### Quick check — code reference test

How many total transport attempts does `callTool` make in the worst case for a rate-limited call, and which constants determine it? (Answer: 4 — 1 initial + `maxRetries = 3`, `lib/mcp/client.ts` L26, loop L49–L53.)

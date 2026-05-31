# Retry + circuit breaker

**Industry name(s):** bounded retry, exponential backoff, Retry-After honoring, jitter, circuit breaker (closed/open/half-open), fail-fast
**Type:** Industry standard · Language-agnostic

> `McpClient.callTool` retries a rate-limited call up to `maxRetries = 3` times with EXPONENTIAL backoff (`retryDelayMs · 2^(retries-1)`, base 10s, capped at `retryCeilingMs = 20s`), preferring a Retry-After window parsed from the error text plus a 500 ms buffer — bounded and correct, with backoff but no jitter — and there is no circuit breaker, so during a sustained provider outage every call still runs the full retry sequence before failing.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Retry + circuit breaker is the Provider wrappers band — the resilience logic between the Agent loop's outbound call and the Tools transport that hits Bloomreach. blooming insights' `McpClient.callTool` retries rate-limit errors up to 3 times, preferring the server's stated Retry-After window (with a 500 ms buffer) and otherwise backing off exponentially off a 10s base, capped at 20s per wait — done well. The circuit breaker — the second mechanism that *stops calling* during a sustained outage — is the gap.

```
  Zoom out — where retry sits and where the breaker would

  ┌─ Agent loop ─────────────────────────────────────┐
  │  outbound tool call                               │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Provider wrappers ─────▼────────────────────────┐  ← we are here
  │  ★ retry: up to 3 attempts ★                      │
  │    Retry-After + 500ms buffer (preferred)         │
  │    else: exponential off 10s, capped at 20s/wait  │
  │    NO jitter — concurrent retries can sync        │
  │                                                   │
  │  ABSENT here:                                     │
  │    - circuit breaker (closed→open→half-open)      │
  │    - fail-fast during outage cooldown             │
  └─────────────────────────┬────────────────────────┘
                            │  HTTPS
  ┌─ Tools + MCP transport ─▼────────────────────────┐
  │  Bloomreach MCP server                            │
  │  outage → every call pays full retry tax (slow)   │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how do you retry transient failures without amplifying a real outage? Retry handles the blip (the failure that clears on its own); a circuit breaker handles the sustained outage (stop calling for a cooldown window, fail fast). Without the breaker, every caller pays the full retry tax during an outage and a flood of retrying clients makes the dying service worse. blooming insights has the first mechanism, not the second — and the backoff lacks jitter, so concurrent retries can synchronize. How it works walks the retry loop, the Retry-After honor, the missing jitter, and the closed/open/half-open shape the breaker would have.

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

The gap: this system's retry loop is correct for a blip but, with no breaker, turns a sustained backend outage into N callers each grinding through 3 retries before failing — exactly the amplification a breaker prevents.

---

### Bounded rate-limit retry (the retry loop)

After the first live call, the retry loop checks whether the result is a rate-limit error and, if so, retries up to a bound, computing each wait from the server's stated Retry-After window when present, else exponential backoff.

```
  function callTool(name, args):
      result  = live_call(name, args)
      retries = 0
      while is_rate_limited(result) and retries < maxRetries:
          retries  += 1
          hintMs    = parse_retry_after_ms(result)             # parsed "Retry after N s"
          backoffMs = retryDelayMs * 2 ** (retries - 1)         # exponential off 10s base
          waitMs    = min(hintMs ? hintMs + 500 : backoffMs,    # capped
                          retryCeilingMs)
          await sleep(waitMs)
          result    = live_call(name, args)
```

`isRateLimited` returns true only when the result has `isError: true` and its text matches `/rate limit|too many requests/i` — so the retry targets exactly the recoverable case, not every error. `maxRetries = 3` (constructor default) bounds the loop. The wait is computed two ways and the smaller-of-(chosen, ceiling) wins: `parseRetryAfterMs` pulls a window out of the error text (`"Retry after ~12 second"` → 12_000, `"per 10 second"` → 10_000) and, when present, the loop waits that hint plus a `RETRY_BUFFER_MS = 500` cushion so the retry lands *after* the penalty clears; when no hint parses, it falls back to exponential backoff `retryDelayMs * 2 ** (retries - 1)` off a 10s base (`retryDelayMs ?? 10_000`). Every wait is capped at `retryCeilingMs = 20_000`. Each retry re-enters the live-call path, which re-applies the 1100 ms spacing gate (see `04-rate-limiting-backpressure.md`), so a retry never violates the rate limit.

```
  liveCall → result
     │
  isRateLimited?
   ┌─ no  → continue (cache / return)
   └─ yes → retries < 3 ?
              ┌─ no  → return the error (exhausted)
              └─ yes → wait = min(hint+500 ?? 10s·2^n, 20s) → liveCall again ─┐
                                                                              └─ loop
```

Total attempts: 1 initial + up to 3 retries = 4 calls. The retry is bounded (no infinite loop), targeted (only 429-equivalents), Retry-After-aware, and exponential — all correct.

---

### The honest limitation — exponential backoff, but no jitter

The wait grows with each retry (the parsed hint is preferred; otherwise 10s, 20s, capped) — but it adds no randomness. Concurrent callers that hit the same 429 compute the same deterministic wait and wake together.

```
 CURRENT (exponential, no jitter):   STANDARD (exponential + jitter):
 attempt 1 → fail                    attempt 1 → fail
   wait 10s (or parsed hint+500)       wait ~10s ± rand
 attempt 2 → fail                    attempt 2 → fail
   wait 20s (capped)                   wait ~20s ± rand
 attempt 3 → fail                    attempt 3 → fail
   wait 20s (capped)                   wait ~20s ± rand
 attempt 4                           attempt 4
```

The backoff is real: the wait doubles off the 10s base and is capped at the 20s ceiling, giving a struggling upstream progressively more room — and the parsed Retry-After window is honored when the server states one, which is better than blind backoff. The one missing refinement is **jitter**: if many callers all hit a 429 at the same moment and all compute the same wait, they wake and retry *simultaneously* — a synchronized burst (thundering herd) that can re-trigger the same rate limit. Jitter (randomizing each delay) desynchronizes them. The connect-MCP helper's comment documents the spacing-vs-window tradeoff and the parsed-hint design — backoff and Retry-After are built; jitter is the remaining hardening.

---

### The bigger gap — no circuit breaker

The retry loop assumes the failure is transient. During a *sustained* backend outage, that assumption is false, and the loop becomes a liability: every tool call runs its full 4-attempt sequence — with the exponential backoff capped at 20s, the three waits are ~10s + 20s + 20s, so ≈ 1100 + 50_000 ≈ 51s of waiting — before failing, for every call, of every agent, of every run.

```
 NO BREAKER (current):
   outage begins
   call 1: try, wait 10s, try, wait 20s, try, wait 20s, try → FAIL  (~51s wasted)
   call 2: try, wait 10s, try, wait 20s, try, wait 20s, try → FAIL  (~51s wasted)
   ...     every call pays the full retry tax, hammering a dead service

 WITH BREAKER (absent):
   call 1..N: failures accumulate → breaker TRIPS (open)
   call N+1..: fail INSTANTLY (no call, no retry) for cooldown
   after cooldown: half-open → one probe → close if it succeeds
```

A circuit breaker tracks recent failures. After a threshold of consecutive failures it **opens** — subsequent calls fail immediately without touching the network or the retry loop. After a cooldown it goes **half-open**, letting one probe through; success **closes** it (resume normal calls), failure re-opens it. This converts a slow, repeated, amplifying failure into a fast, cheap one — and stops the retry flood from worsening the outage. This system has none of this: there is no failure counter, no open/closed state, no fast-fail path.

---

### Current state vs future state

```
            built                          absent
            ──────────────────────         ────────────────────────────
retry       bounded loop (maxRetries 3)     —
            targeted (isRateLimited)
delay       exponential backoff (10s→20s)   —
            + parsed Retry-After + 500ms
jitter      —                              randomized delay (anti-herd)
breaker     —                              open/half-open/closed + cooldown
fail-fast   —                              instant fail during outage
```

One refinement and one new mechanism are missing: jitter (randomize the backoff) and a circuit breaker (fail fast during sustained outage). The retry foundation — bounded, targeted, Retry-After-aware, exponential — is sound; these harden it.

---

### The principle

Retry recovers from transient failure; a circuit breaker protects against sustained failure — and a flood of retries without a breaker amplifies an outage instead of surviving it. The bounded, targeted, Retry-After-aware retry you built — backing off exponentially off a 10s base — is the correct foundation. The remaining refinement (jitter to desynchronize concurrent retries) and the breaker (to fail fast and stop hammering a dead upstream) are what turn a retry that *works for a blip* into one that *survives an outage*. The lesson generalizes: every retry loop needs a bound, and every bounded retry that runs at scale needs a breaker in front of it.

---

## Retry + circuit breaker — diagram

This diagram spans the Agent, Service, and Provider layers. The retry loop (with backoff + Retry-After) is built (solid); jitter and the breaker are the gaps (dashed).

```
  ┌────────────────────────────────────────────────────────────────────┐
  │  AGENT LAYER   lib/agents/base.ts                                    │
  │  mcp.callTool(name, args)                                            │
  └───────┼──────────────────────────────────────────────────────────────┘
          │
  ┌───────▼──────────────────────────────────────────────────────────────┐
  │  SERVICE LAYER   lib/mcp/client.ts                                    │
  │                                                                       │
  │  ╎ BREAKER  (ABSENT): if open → fail fast, skip call entirely ╎       │
  │       │ (no breaker today)                                            │
  │  ┌────▼─────────────────────────────────────────────┐               │
  │  │  result = liveCall  (applies 1100ms spacing)│               │
  │  └────┬─────────────────────────────────────────────┘               │
  │       │                                                               │
  │  ┌────▼──────────────────────────────────────────────────┐          │
  │  │  Retry loop  (BUILT)                                    │          │
  │  │  while isRateLimited(result) && retries < 3:           │          │
  │  │    retries++                                            │          │
  │  │    hint = parseRetryAfterMs(result)                     │          │
  │  │    backoff = 10s · 2^(retries-1)                        │          │
  │  │    wait = min(hint+500 ?? backoff, 20s)  ── no jitter   │          │
  │  │    sleep(wait); result = liveCall                       │          │
  │  └────┬──────────────────────────────────────────────────┘          │
  │       │ isRateLimited test: isError && /rate limit/i                 │
  │       │ maxRetries=3, retryDelayMs=10_000, ceiling=20_000    │
  │       │ RETRY_BUFFER_MS=500, parseRetryAfterMs                   │
  └───────┼──────────────────────────────────────────────────────────────┘
          │  NETWORK / PROVIDER BOUNDARY
  ┌───────▼──────────────────────────────────────────────────────────────┐
  │  PROVIDER   Bloomreach MCP server                                     │
  │  transient 429 → retry recovers (honors stated Retry-After window)    │
  │  sustained outage → every call pays full retry tax (no breaker)       │
  └───────────────────────────────────────────────────────────────────────┘
```

A reader who sees only this diagram should grasp: bounded retry on 429 is built with exponential backoff and a parsed Retry-After window; jitter and a fail-fast breaker are the missing hardening.

---

## Implementation in codebase

Partially implemented — bounded rate-limit retry with exponential backoff and Retry-After honoring is built; jitter and a circuit breaker are not.

### Bounded rate-limit retry with backoff (Case A)

**File:** `lib/mcp/client.ts`
**Function / class:** `McpClient.callTool` retry loop
**Line range:** L122–L132 (loop), with `isRateLimited` at L18–L22 and `parseRetryAfterMs` at L31–L38. Constructor defaults `maxRetries = 3` (L89), `retryDelayMs = 10_000` (L93, the backoff base), `retryCeilingMs = 20_000` (L94, the per-wait cap); `RETRY_BUFFER_MS = 500` at module scope (L16). The wait is `Math.min(hintMs != null ? hintMs + RETRY_BUFFER_MS : retryDelayMs · 2^(retries-1), retryCeilingMs)` (L125–L129). The loop re-enters `liveCall` (L148–L163), which re-applies the 1100 ms spacing.

The live values are set in `connectMcp` (`lib/mcp/connect.ts` L91–L96): `{ minIntervalMs: 1100, retryDelayMs: 10_000, retryCeilingMs: 20_000, maxRetries: 3 }`, with the rationale (proactive 1.1s spacing, wait out the *stated* window on retry, 60s cache absorbs repeats) in the comment at L81–L88.

Honest note: the backoff is **exponential** (`retryDelayMs · 2^(retries-1)`, L125) and prefers a parsed Retry-After window (L124, L127) — but it adds **no jitter**, so concurrent callers compute the same deterministic wait and can wake together.

### Circuit breaker (Case B — Not yet implemented)

**Not yet implemented.** blooming insights has a bounded, exponential-backoff rate-limit retry but no circuit breaker — there is no failure counter, no open/closed state, and no fast-fail path, so during a sustained Bloomreach outage every `callTool` runs its full retry sequence (~51s of waiting: 10s + 20s + 20s under the 20s ceiling) before failing.

Where it would live: a breaker would wrap the retry loop in `McpClient.callTool` (`lib/mcp/client.ts` L113–L132), tracking consecutive failures in instance state alongside `lastCallAt` (L81). When the count crosses a threshold the breaker opens — `callTool` returns a fast failure before `liveCall` (L113) — and a timestamp-based cooldown transitions it to half-open for a single probe. Jitter would wrap the `waitMs` computation at L126–L129 with a randomization term so concurrent retries desynchronize.

---

## Elaborate

### Where this pattern comes from

**Bounded retry** is the standard recovery for transient failures, formalized in distributed-systems literature decades ago: most transient faults clear on a second attempt, and a bound prevents an infinite loop against a permanently-broken upstream. **Exponential backoff** (double the delay each attempt) and **jitter** (randomize it) were popularized by AWS's "Exponential Backoff And Jitter" (2015), which showed that synchronized retries create a thundering herd and that jitter dramatically reduces contention. **The circuit breaker** was named by Michael Nygard in *Release It!* (2007) — borrowed from electrical breakers, it trips to protect a failing downstream from a flood of doomed requests, with closed/open/half-open states and a cooldown.

### The deeper principle

```
  failure type        right mechanism            blooming insights
  ─────────────────   ────────────────────────   ─────────────────────
  transient blip      bounded retry + backoff     retry + backoff YES
  rate-limit window   honor Retry-After           YES (parsed + 500ms)
  concurrent retries  jitter (desynchronize)      ABSENT (no jitter)
  sustained outage    circuit breaker (fail fast)  ABSENT
```

Retry and circuit breaker are complements, not alternatives. Retry assumes the failure is temporary and worth re-attempting; the breaker recognizes when that assumption has broken and stops re-attempting. A system with retry but no breaker handles blips and amplifies outages — which is precisely where blooming insights sits.

### Where this breaks down

The deterministic (un-jittered) backoff creates a thundering herd: if an agent fires several tool calls that all 429 at once and all compute the same wait, they retry in lockstep and can re-trigger the limit. The backoff itself is sound — it grows 10s → 20s (capped) and honors a stated Retry-After window — but without jitter the *timing* synchronizes. Without a breaker, a Bloomreach outage means every call across every agent pays ~51s of retry waiting before failing — and within the `maxDuration = 300` route budget (`app/api/agent/route.ts` L20), a handful of such calls consume the entire request window, so the run times out mid-stream instead of failing fast with a clear error.

### What to explore next

- `p-retry` — bounded retry with exponential backoff, jitter, and a custom `shouldRetry` predicate; a drop-in for the `while (isRateLimited)` loop
- `cockatiel` / `opossum` — resilience libraries providing a full circuit breaker (states, thresholds, cooldown) plus retry and timeout
- Decorrelated jitter — AWS's recommended jitter variant that bounds growth while fully randomizing
- Bulkheads + timeouts — the sibling resilience patterns that pair with retry and breaker for full fault isolation

---

## Project exercises

### Add jitter and a fail-fast circuit breaker

- **Exercise ID:** B5.4 (adapted) — provenance C5.5 (retry / circuit-breaker).
- **What to build:** Add jitter to the existing exponential backoff in the retry loop (e.g. wrap the computed `waitMs` with `± random`), and add a circuit breaker around `callTool`: track consecutive failures, **open** the breaker after a threshold (subsequent calls fail fast without touching the network or the retry loop), transition to **half-open** after a cooldown for a single probe, and **close** on a successful probe.
- **Why it earns its place:** it completes the resilience pair — retry that does not herd, plus a breaker that fails fast during an outage — the senior signal that you know retry alone amplifies outages.
- **Files to touch:** `lib/mcp/client.ts` (add jitter to the `waitMs` computation at L126–L129; wrap the retry loop L122–L132 with breaker state alongside `lastCallAt` at L81), `test/mcp/client.test.ts` (extend the retry tests: assert jittered delays, and that the breaker opens after N failures and fails fast).
- **Done when:** retries use a randomized (jittered) delay on top of the growth; after the failure threshold the breaker opens and subsequent `callTool` calls return a fast failure without calling `liveCall`; after the cooldown a single probe can close it — all verified by tests against a fake transport that fails on demand.
- **Estimated effort:** 1–2 days.

### Retry transient 5xx, not just rate limits

- **Exercise ID:** C5.5 (retry) — fresh, no clean Build map.
- **What to build:** Broaden the retry predicate beyond `isRateLimited` to also retry transient server errors (5xx-equivalent results), while keeping non-retryable errors (bad query, 4xx) failing immediately — so the retry targets the full transient class, not only 429s.
- **Why it earns its place:** shows you can distinguish retryable from non-retryable failures, the judgment that prevents both under- and over-retrying.
- **Files to touch:** `lib/mcp/client.ts` (`isRateLimited` at L18–L22 generalized to an `isRetryable` predicate; the loop condition at L122).
- **Done when:** a transient server-error result is retried and a non-retryable client error is not — verified by tests with a fake transport returning each error class.
- **Estimated effort:** <1hr.

---

## Interview defense

### What an interviewer is really asking

"How do you handle a failing upstream?" tests whether you know retry alone is insufficient — that without a breaker, retries amplify an outage. The weak answer is "I retry with backoff." The strong answer pairs bounded retry with backoff (for blips, honoring a stated Retry-After window) with a circuit breaker (for sustained failure) and explains why un-jittered delays herd while jitter does not.

### Likely questions

**[mid] When does `callTool` retry, and how long does it wait?**

Only when `isRateLimited(result)` is true — `isError: true` and the text matches `/rate limit|too many requests/i` (`lib/mcp/client.ts` L18–L22). Up to `maxRetries = 3` times (L89). Each wait prefers a parsed Retry-After window (`parseRetryAfterMs` L31–L38) plus a 500 ms buffer; absent a hint it uses exponential backoff `10s · 2^(retries-1)` (L125), every wait capped at 20s (L94). Total: 1 initial + 3 retries = 4 calls.

```
  liveCall → 429 → wait(hint+500 ?? 10s·2^n, capped 20s) → liveCall → ... → exhaust
            (max 4 attempts)
```

**[senior] You have exponential backoff. What's still missing?**

Jitter. The wait grows (10s → 20s, capped) and honors the server's stated window — good — but it is deterministic, so if several calls 429 at once they all compute the *same* wait and retry simultaneously: a thundering herd that re-triggers the limit. Jitter (randomizing each delay) desynchronizes them on top of the growth already there.

```
  no jitter: all wake at same backoff → synchronized retry burst
  jitter:    wake at backoff ± rand   → spread out, no herd
```

**[arch] Bloomreach is down for 10 minutes. What does your retry loop do, and what should happen instead?**

Every `callTool` runs its full 4-attempt sequence (~51s of waiting: 10s + 20s + 20s under the 20s ceiling) before failing — for every call, amplifying the outage and eating the 300s route budget. A circuit breaker should trip after N failures and fail fast (no call, no retry) until a cooldown, then half-open for one probe.

```
  no breaker: call → ~51s → fail, repeat for every call
  breaker:    N fails → OPEN → fail instantly → cooldown → half-open probe
```

### The question candidates always dodge

**"Isn't retry enough? Why add a circuit breaker?"**

No — and conflating them is the tell. Retry assumes the failure is transient; during a real outage that assumption is false and retry *amplifies* the problem (every caller hammering a dead service through its full retry sequence). The breaker is the mechanism that detects "this is not transient" and stops retrying — failing fast and giving the upstream room to recover. Retry handles the blip; the breaker handles the outage; you need both.

### One-line anchors

- `lib/mcp/client.ts` L122–L132 — bounded rate-limit retry loop with backoff
- `lib/mcp/client.ts` L18–L22 — `isRateLimited`, the targeted retry predicate
- `lib/mcp/client.ts` L31–L38 — `parseRetryAfterMs`, the stated-window parser
- `lib/mcp/client.ts` L89/L93/L94 — `maxRetries = 3`, `retryDelayMs = 10_000`, `retryCeilingMs = 20_000`
- `lib/mcp/client.ts` L125–L129 — exponential backoff + hint-vs-backoff `Math.min` (no jitter)
- `lib/mcp/connect.ts` L81–L88 — comment on spacing vs. parsed-window tradeoff

---

## Validate

### Level 1 — Reconstruct

From memory, write the retry loop's three moving parts (the predicate that decides retryability, the bound, the wait computation). State how the wait is chosen (parsed Retry-After + 500ms preferred, else exponential backoff off a 10s base, capped at 20s). Then state the one refinement the wait lacks (jitter) and the one mechanism that is entirely absent (circuit breaker), with what each protects against.

### Level 2 — Explain

Out loud: explain why an un-jittered (deterministic) backoff still creates a thundering herd under concurrency and how jitter fixes it. Then explain why retry without a circuit breaker *amplifies* a sustained outage rather than surviving it.

### Level 3 — Apply

Scenario: Bloomreach is down and investigations are timing out instead of failing cleanly. Open `lib/mcp/client.ts` L122–L132 and `app/api/agent/route.ts` L20. Calculate the worst-case wait for a single `callTool` with no parsed hint (initial 1100 ms spacing + backoff 10s + 20s + 20s under the 20s ceiling ≈ 51s) and explain how a couple such calls eat a large slice of the 300s `maxDuration` budget. Then state where a breaker would short-circuit this (before `liveCall` at L113).

### Level 4 — Defend

A teammate says "the bounded retry with backoff is fine, we don't need a circuit breaker." Defend the breaker: cite the worst-case per-call retry tax (~51s, `lib/mcp/client.ts` L122–L132), explain how it amplifies an outage and threatens the 300s route budget (`app/api/agent/route.ts` L20), and name what the breaker adds that retry cannot — a fast-fail path during sustained failure.

### Quick check — code reference test

How many total transport attempts does `callTool` make in the worst case for a rate-limited call, and which constant determines it? (Answer: 4 — 1 initial + `maxRetries = 3`, `lib/mcp/client.ts` L89, loop L122–L132.)

## See also

→ 04-rate-limiting-backpressure.md · → 01-llm-caching.md · → ../04-agents-and-tool-use/README.md

---
Updated: 2026-05-28 — Corrected the retry framing from "fixed 1200ms delay" to the real exponential backoff (10s base, 20s ceiling) with parsed Retry-After + 500ms buffer; re-derived all client.ts line refs; worst-case retry tax now ~51s and the route budget is 300s.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".

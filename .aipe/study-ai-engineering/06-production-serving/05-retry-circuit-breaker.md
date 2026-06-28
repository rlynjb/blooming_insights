# 05 — retry and circuit breaker

**Subtitle:** Retry-with-backoff (present) + circuit breaker (Case B) · Industry standard

## Zoom out, then zoom in

**Retry is present** (in `BloomreachDataSource`, see previous file).
**Circuit breaker is Case B** — there's no "is the provider currently
broken?" gate that fast-fails the rest of the request when it knows
the provider is down. Today, every tool call to a down provider
incurs the full retry budget before failing.

```
  Zoom out — retry catches transient failures; circuit catches sustained

  ┌─ tool call ────────────────────────────────────┐
  │  ┌─ retry (present) ──────────────────────────┐ │  ← we covered in 04
  │  │  parse retry-after, sleep, retry up to 3x  │ │
  │  └────────────────────────────────────────────┘ │
  │  ┌─ circuit breaker (Case B) ─────────────────┐ │  ← we are here
  │  │  if N recent failures: OPEN — fail fast    │ │
  │  │  after T: HALF-OPEN — try one              │ │
  │  │  succeed: CLOSED; fail: OPEN again         │ │
  │  └────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — failure shape.** Retry handles *transient*
    failures (a single rate-limit error, a temporary network blip).
    Circuit breaker handles *sustained* failures (provider down for
    minutes). Different mechanisms for different failure profiles.

## How it works

### Move 1 — the mental model

You've seen this pattern in resilient HTTP clients (Polly for .NET,
Hystrix for Java, Resilience4j). Two layers, layered:

```
  Retry — handles transient
  ──────────────────────────
  attempt 1: fail
  attempt 2: fail
  attempt 3: succeed → return
  (most failures clear within 3 tries)

  Circuit breaker — handles sustained
  ───────────────────────────────────
  attempt 1: fail
  attempt 2: fail
  attempt 3: fail
  attempt 4: fail
  attempt 5: fail → OPEN CIRCUIT (provider seems down)
  next 30s of calls: fail fast (no provider attempt)
  attempt at 30s mark: HALF-OPEN, try one
   success → CLOSE (normal operation resumes)
   failure → OPEN again, wait another 30s
```

### Move 2 — the step-by-step walkthrough

**The retry side is in place.** See
`04-rate-limiting-backpressure.md` for the full walkthrough of
`BloomreachDataSource.callTool`'s retry ladder. Three attempts max,
each capped at 20s wait, server-stated hint preferred over backoff.

**What retry alone doesn't solve.** Three scenarios where retry-only
hurts:

  1. **Provider is down for several minutes.** Every tool call burns
     ~30s (3 retries × 10s avg) before failing. A 6-tool diagnostic
     loop takes ~180s instead of failing fast at ~5s.

  2. **OAuth token revoked.** Bloomreach's alpha server revokes tokens
     after minutes; the next tool call returns auth error, retry
     loops through attempts (auth doesn't fix during the wait), eats
     budget, returns auth error. Today's mitigation is
     `useReconnectPolicy` on the client side — on `invalid_token` error,
     reset and reload. This is *application-level circuit breaking*,
     not a generic circuit breaker.

  3. **Anthropic API outage.** Rare but happens. Every model call would
     retry (via the SDK's built-in retry), each taking ~30s, until the
     whole route times out. A circuit breaker would detect the pattern
     and fail fast.

**The hypothetical circuit breaker** for `BloomreachDataSource`:

```typescript
// lib/data-source/circuit-breaker.ts (Case B)
type CircuitState = 'closed' | 'open' | 'half_open';

class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private openedAt: number = 0;
  private readonly failureThreshold = 5;
  private readonly openDurationMs = 30_000;

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt < this.openDurationMs) {
        throw new Error('circuit open — failing fast');
      }
      this.state = 'half_open';   // time to try
    }

    try {
      const result = await fn();
      if (this.state === 'half_open') this.state = 'closed';
      this.failureCount = 0;
      return result;
    } catch (e) {
      this.failureCount++;
      if (this.failureCount >= this.failureThreshold) {
        this.state = 'open';
        this.openedAt = Date.now();
      }
      throw e;
    }
  }
}
```

Wired into `BloomreachDataSource`:

```typescript
// hypothetical wiring
private breaker = new CircuitBreaker();

async callTool(...) {
  return this.breaker.call(() => this.actualCallTool(...));
}
```

**Per-instance vs distributed state.** On Vercel, every instance has
its own circuit-breaker state. A circuit that opens on instance A
doesn't tell instance B. For per-user circuit breaking
(distributed), you'd need Vercel KV / Upstash Redis to share state.
For per-instance, in-memory is fine — each instance will independently
detect "provider down" within 5 failures.

**Why this isn't built today.** Three reasons:

  → The dominant failure mode (rate limit) is handled by retry — the
    server is *intentionally* slow, not broken.
  → The OAuth-revocation failure is handled by client-side reconnect —
    detection lives in the UI, not the data source.
  → A general Anthropic outage hasn't happened during development;
    when it does, the route's 300s budget eventually expires and the
    user sees a generic error.

It's a real Case B — would land in a more mature production
deployment but doesn't earn its place yet.

### Move 3 — the principle

**Retry handles transient failures (a single bad response). Circuit
breakers handle sustained failures (provider down for minutes). Layer
them — retry inside the breaker, breaker outside the retry — so each
operates at its right scope.** A retry-only system burns budget when
the provider is down; a circuit-breaker-only system retries less than
it should on a single transient error.

## Primary diagram

```
  Retry + circuit breaker, layered

  call site
       │
       ▼
  ┌─ Circuit breaker check ──────────────────────────┐
  │  state == 'open' AND (now - openedAt) < T?       │
  │  YES → throw 'circuit open' (fail fast)          │
  │  NO → continue                                   │
  └──────────────────────┬───────────────────────────┘
                         │
                         ▼
  ┌─ Retry ladder (existing — 04-rate-limiting-…) ──┐
  │  attempt 1: ok? → return                        │
  │  attempt 2: ok? → return; reset failure count   │
  │  attempt 3: ok? → return                        │
  │  all 3 failed → throw                           │
  └──────────────────────┬───────────────────────────┘
                         │
                         ▼
  ┌─ Circuit breaker outcome ────────────────────────┐
  │  success → failureCount = 0; state = 'closed'   │
  │  failure → failureCount++; if >= threshold:     │
  │             state = 'open'; openedAt = now      │
  └───────────────────────────────────────────────────┘
```

## Elaborate

The circuit breaker pattern is canonical in distributed systems
(Hystrix popularized it; the AWS Well-Architected Framework prescribes
it). The Netflix-style implementation has more nuance (rolling
windows, half-open trial volume, fallback functions) but the kernel
is the three-state machine above.

For LLM-shaped systems specifically, circuit breaking matters at TWO
boundaries: the model provider (Anthropic) and the data source
(Bloomreach MCP, or whoever). blooming insights' data-source side is
the more pressing one because Bloomreach's alpha is less reliable
than Anthropic. The Anthropic SDK has built-in retry but not breaker
behavior — adding one on the Blooming side would catch sustained
Anthropic outages.

## Project exercises

### Exercise — add a per-instance circuit breaker to BloomreachDataSource

  → **Exercise ID:** `study-ai-eng-06-05.1`
  → **What to build:** New `lib/data-source/circuit-breaker.ts` with
    the three-state machine. Wire into `BloomreachDataSource` so every
    `callTool` flows through `breaker.call(() => this.actualCallTool(...))`.
    Add a trace event when the circuit opens / closes / half-opens so
    the UI can show "circuit open — failing fast" instead of just
    "error."
  → **Why it earns its place:** Industry-standard resilience pattern.
    Today a sustained Bloomreach outage burns the full route budget
    before failing; with a breaker it fails in <10ms after threshold.
  → **Files to touch:** new `lib/data-source/circuit-breaker.ts`,
    `lib/data-source/bloomreach-data-source.ts` (wrap callTool),
    `lib/mcp/events.ts`, `test/data-source/circuit-breaker.test.ts`.
  → **Done when:** Force-failing 5 consecutive calls trips the breaker
    open; calls within the next 30s fail in <10ms; after 30s the
    breaker tries once and either re-opens or closes.
  → **Estimated effort:** `1–2 days`

### Exercise — add the same breaker to AnthropicModelProviderAdapter

  → **Exercise ID:** `study-ai-eng-06-05.2`
  → **What to build:** Wrap `complete()` in a circuit breaker (shared
    instance per provider). Differentiates "provider quirks
    transient" (rate limit, single 5xx) from "provider down."
  → **Why it earns its place:** Defense in depth at the OTHER provider
    boundary. Anthropic outages should fail fast, not burn the full
    route budget.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts:42-71`,
    shared breaker instance.
  → **Done when:** Force-failing 5 consecutive Anthropic calls trips
    the breaker; subsequent calls fail in <10ms until reset.
  → **Estimated effort:** `1–4hr` (once the breaker lib from
    exercise 1 exists).

## Interview defense

**Q: Does this codebase have a circuit breaker?**

Not yet. Retry is in place
(`BloomreachDataSource.callTool` — see
`04-rate-limiting-backpressure.md`); circuit breaker isn't. Today, a
sustained provider failure burns the full retry budget on every tool
call — 30s+ per call. A circuit breaker would detect the pattern
(N consecutive failures) and fail fast for T seconds, sparing the
route budget.

```
  layered resilience:

   retry (present):    handles transient failures
                        one rate-limit, one network blip
   breaker (Case B):   handles sustained failures
                        provider down for minutes
```

**Anchor line:** "Retry catches transient, breaker catches sustained.
We have one of the two. The breaker is on the next-up list when live
traffic justifies it."

**Q: Why isn't circuit breaker built yet?**

Three reasons. (1) The dominant failure mode (Bloomreach rate limit)
is intentional throttling, not provider brokenness — retry handles it
correctly. (2) OAuth-revocation has its own client-side reconnect
mitigation (`useReconnectPolicy`). (3) A general Anthropic outage
hasn't actually hurt during development. It's real Case B — earns its
place at higher user volume or when Anthropic outages start eating
route budget.

The build is straightforward: three-state machine wrapping
`callTool` and `complete`. Per-instance state on Vercel is acceptable
(each instance independently detects the outage); distributed state
via KV would be the upgrade if cross-instance coordination matters.

## See also

  → `04-rate-limiting-backpressure.md` — the retry layer this would
    sit on top of
  → `04-agents-and-tool-use/06-error-recovery.md` — where breaker
    "circuit open" errors would surface to the user

# 05 — Retry and circuit breaker

**Type:** Industry standard.

## Zoom out, then zoom in

Retry with backoff is present in `BloomreachDataSource`. Circuit breaker is NOT.

```
  Zoom out — what's present vs what's not

  ┌─ Retry (present) ─────────────────────────────────────────────────┐
  │  BloomreachDataSource retry ladder                                 │
  │  parses retry-after, bounded by maxRetries                         │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ Circuit breaker (NOT present) ───────────────────────────────────┐
  │  No open/half-open/closed state machine                            │
  │  Would fail-fast after N consecutive failures                      │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. Retry handles transient failures (network blips, one-off rate limits). Circuit breaker handles sustained failures (provider down) — prevents hammering a broken service. This codebase has the first, not the second, because the alpha Bloomreach MCP server's failure mode is intermittent-rate-limit (retry-shaped), not sustained-outage (breaker-shaped).

## Structure pass

Axis: what does each pattern protect against?
- Retry: transient failure — one call fails, the next may succeed
- Circuit breaker: sustained failure — many calls fail in a row; further calls likely to fail too

**Seam:** the retry logic in `BloomreachDataSource`. Circuit-breaker seam would be one layer above (a wrapper that fails fast when the breaker is open).

## How it works

### Move 1

You've written a retry loop. You've also seen retry storms — 100 clients retrying a broken service in unison, making it worse. Circuit breaker is the countermeasure.

```
  Retry               Circuit breaker
  ─────               ────────────────
  one call            many calls
  transient failure   sustained failure
  wait & try again    fail fast for T seconds; then try once; then close or open
```

### Move 2

**Retry — present in `BloomreachDataSource`.**

The retry loop wraps `callTool`. On 429 or specific rate-limit shapes:
1. Parse the server's stated retry window (`parseRetryAfterMs`).
2. Sleep for that duration + `RETRY_BUFFER_MS = 500` cushion.
3. Retry, up to `maxRetries` times.
4. If still failing, throw the error.

Bounded and exponential-shaped fallback (backoff base + attempt count when no hint present).

**Circuit breaker — not present.**

Standard shape:
- **Closed** (normal): calls flow through. Track failure count on a rolling window.
- **Open** (broken): failure count exceeded threshold. Calls fail fast with `ServiceUnavailable`; no upstream call.
- **Half-open** (probing): after `openDurationMs`, one probe call is allowed. If succeeds → close. If fails → open again.

Why not built:
- The alpha Bloomreach MCP server's failure mode is intermittent-per-request, not sustained. Retry handles it.
- Traffic volume is low — no risk of retry storms.
- The eval / load harness paths use synthetic (never fails) or fault-injected (transient by design).

When it would matter:
- Real production traffic against a service that GOES DOWN for minutes at a time. Anthropic's own API would be the more likely target — if Anthropic is down, the app should fail fast rather than have every user's investigation hang.

### Move 3

Retry for transient; breaker for sustained. This codebase has retry because it needs it; adding a breaker would be Case B in a state where traffic volume + service failure mode make retry storms possible. Neither absent nor present is inherently right — it's about matching the tool to the failure surface.

## Primary diagram

```
  Retry present + breaker Case B

  ┌─ BloomreachDataSource.callTool ───────────────────────────────────┐
  │  attempt = 0                                                       │
  │  while attempt < maxRetries {                                      │
  │    result = await transport.send(...)                              │
  │    if !isRateLimited(result) return result                         │
  │    wait = parseRetryAfterMs(result) ?? backoff(attempt)            │
  │    await sleep(wait + RETRY_BUFFER_MS)                             │
  │    attempt++                                                       │
  │  }                                                                 │
  │  throw ToolCallError                                               │
  └───────────────────────────────────────────────────────────────────┘

  Case B — breaker wraps the above

  ┌─ CircuitBreaker (proposed) ───────────────────────────────────────┐
  │                                                                    │
  │        closed ──── failure threshold exceeded ────► open          │
  │           ▲                                          │             │
  │           │                                          │  sleep      │
  │           │                                          ▼  openDur.   │
  │        (probe succeeds)                           half-open        │
  │           │                                          │             │
  │           └───────── (probe succeeds) ───────────────┘             │
  │                                                                    │
  │  when open: reject calls immediately, don't hit BloomreachDS.      │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

Circuit breaker was popularized by Michael Nygard's "Release It!" (2007). Netflix's Hystrix (deprecated) was the canonical implementation. Modern practice uses simpler variants — Resilience4j (JVM), Polly (.NET). Node.js implementations tend to be handwritten because they're small.

The key knobs: failure threshold (typically 50%+ of a rolling window), open duration (30-60 seconds), probe interval. Tune based on downstream service SLAs.

## Project exercises

### Exercise — circuit breaker around Anthropic API calls

- **Exercise ID:** C5.5-B · Case B (retry present; breaker not).
- **What to build:** wrap `AnthropicModelProviderAdapter.complete()` with a circuit breaker. Threshold: 5 consecutive failures. Open duration: 30s. Half-open probe: 1 call. On open, throw `ServiceUnavailable` immediately without hitting Anthropic.
- **Why it earns its place:** if Anthropic goes down, this fails fast instead of hanging every investigation. Interviewer signal: "I know when retry isn't enough — here's my breaker."
- **Files to touch:** `lib/agents/circuit-breaker.ts` (new), `lib/agents/aptkit-adapters.ts` (wrap complete()).
- **Done when:** simulating 5 consecutive Anthropic failures opens the breaker; next 30s of calls fail fast; after 30s a probe attempts.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: Do you have retry?**

Yes — in `BloomreachDataSource`. Parses the server's retry-after header for both known shapes ("Retry after ~N second(s)" and "rate limit reached (1 per N second)"). Adds a 500ms cushion. Bounded by maxRetries. Falls back to backoff if no hint present.

**Q: Circuit breaker?**

Not built. The failure mode I face is intermittent-per-request rate limiting (retry-shaped), not sustained outage (breaker-shaped). Would add a breaker around the Anthropic API call if traffic grew to where retry storms could hurt the shared quota, but at demo scale it's not the load-bearing move.

**Q: When would you add a breaker?**

Two triggers. (1) If Anthropic went down for minutes at a time — I'd rather fail fast than have every user's investigation hang for 30s waiting on retries. (2) If a downstream service (Bloomreach) started returning sustained 500s — a breaker would prevent cascading load onto a service that's already struggling. Neither has happened at this repo's scale, so it's Case B.

```
  retry:   transient failure    → wait, try again        (present)
  breaker: sustained failure    → stop trying, probe    (not present)
```

## See also

- `04-rate-limiting-backpressure.md` — the ~1 req/s outbound throttle
- `04-agents-and-tool-use/06-error-recovery.md` — the agent-side view when retry is exhausted
- `lib/data-source/bloomreach-data-source.ts` — the retry site

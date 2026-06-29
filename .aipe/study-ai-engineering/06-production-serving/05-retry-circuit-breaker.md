# Retry and circuit breaker

*Industry standard — exponential backoff with jitter · circuit breaker*

## Zoom out — where this concept lives

Two patterns that layer for production resilience. **Retry with backoff** is shipped today inside `BloomreachDataSource` — exponential fallback when no hint is parseable, parsed-window when one is, with a 20s ceiling and 3-attempt max. **Circuit breaker is NOT shipped.** When Bloomreach is down for sustained minutes, every new request burns up to 60s in retries before failing.

```
  Zoom out — two patterns, layered

  ┌─ Retry with backoff (shipped) ───────────────────────────┐
  │  Where: BloomreachDataSource.callTool line 153-170       │
  │  Hint-first (parsed window) → backoff fallback           │
  │  Max 3 retries, 20s ceiling                              │
  │  Handles: transient failures (network blips, rate limit) │
  └──────────────────────────────────────────────────────────┘
  ┌─ ★ Circuit breaker (not shipped) ★ ──────────────────────┐ ← we are here
  │  Would handle: sustained failures (server down 5+ min)   │
  │  Without it: every new request burns retries before      │
  │              failing → bad user experience               │
  │  Exercise: B4.6 in 04-agents-and-tool-use/06-error-      │
  │             recovery.md                                  │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** Retry handles "the server hiccupped." Circuit breaker handles "the server is having a bad time and hammering it isn't helping." Both are needed for full production resilience; this codebase has the first and not the second.

## Structure pass — layers · axes · seams

**Layers:** call → fail → retry decision → wait → retry / fail-fast.

**Axis: when do you keep trying vs give up?** Retry: when failures might be transient. Circuit breaker: when failures are clearly sustained (N consecutive fails in M seconds).

**Seam:** the retry loop at `lib/data-source/bloomreach-data-source.ts:153-170`. Adding a circuit breaker would wrap this loop with a check ("circuit open? fail fast"); see the `B4.6` exercise.

## How it works

### Move 1 — the mental model

You know how a smart user retries clicking a button once or twice when a page errors, but stops trying after the third time because they realize the site is down? Retry is the first two clicks; circuit breaker is the third-click recognition.

```
  Retry (shipped) and circuit breaker (not) — layered patterns

  Retry with backoff:
   ──────────────────
   attempt 1 fails → wait W1 → attempt 2
   attempt 2 fails → wait W2 → attempt 3
   attempt 3 fails → throw

   For transient failures: brief windows, network blips, the
    server is briefly unhappy. Three attempts usually resolve it.

  Circuit breaker:
   ────────────────
   after N consecutive failures across requests (e.g. 5 in 60s),
   OPEN the circuit. New requests fail FAST (~1ms) without trying.

   After T seconds (e.g. 60s), HALF-OPEN. Try one request.
    If it succeeds, CLOSE.
    If it fails, re-OPEN.

   For sustained failures: server down for minutes/hours.
    Stops hammering a broken service and gives the user a
    fast error instead of a long wait.
```

### Move 2 — the step-by-step walkthrough

**Part 1 — retry, shipped.**

`BloomreachDataSource.callTool` at `lib/data-source/bloomreach-data-source.ts:153-170`:

```typescript
let retries = 0;
while (isRateLimited(result) && retries < this.maxRetries) {
  retries++;
  const hintMs = parseRetryAfterMs(result);
  const backoffMs = this.retryDelayMs * 2 ** (retries - 1);
  const waitMs = Math.min(
    hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,
    this.retryCeilingMs,
  );
  await sleep(waitMs);
  result = await this.liveCall(name, args, options.signal);
}
```

Six properties:

  → **`maxRetries = 3`** — bounded number of attempts.
  → **Hint-first.** If the server says "retry after 12s," wait 12.5s. If not, exponential backoff.
  → **Exponential backoff** with `retryDelayMs * 2^(retries-1)`. Default `retryDelayMs = 10_000ms`. So waits are 10s, 20s, 40s.
  → **`retryCeilingMs = 20_000`** caps any wait at 20s.
  → **No jitter today.** Classical retry-with-backoff adds random jitter (±20%) to avoid synchronized retries from many clients. This codebase doesn't, because there's only one client per `BloomreachDataSource` instance (per-session). When the cross-session rate limiter (`B6.4`) lands, jitter becomes more relevant.
  → **`AbortSignal` threaded** — each `sleep(waitMs)` and `liveCall` respects the route's cancellation. Tab closes mid-retry, the route exits cleanly.

**Part 2 — circuit breaker, not shipped.**

There is no circuit breaker today. When Bloomreach is down for sustained minutes, every new request:

```
  Today's behavior on Bloomreach outage:
   ──────────────────────────────────────
   User request 1 → live call fails → wait 10s → retry fails → wait 20s →
                    retry fails → throw → route emits 'error' event → user sees error
   Total: ~30s wall-clock to surface an error.

   User request 2 (immediately after) → same path → another 30s.
   User request 3 → same path → another 30s.

   The server doesn't care about retries; users wait 30s per attempt
    just to get told "service unavailable."
```

The desired behavior with a circuit breaker:

```
  With circuit breaker:
   ────────────────────
   Request 1: fails after 30s (3 retries). Failure counter += 1.
   Request 2: fails after 30s. Failure counter += 1.
   Request 3: fails after 30s. Failure counter += 1.
   ... at 5 consecutive failures in 60s → OPEN the circuit.

   Request 6 → CircuitOpenError immediately (<5ms).
   ... 60 seconds later, HALF-OPEN → try one.
     If success: CLOSE, all requests resume normally.
     If failure: OPEN again, fail fast for another 60s.
```

The benefit: after 5 failures, users get errors in <100ms instead of 30s. Big UX improvement during sustained outages.

**Part 3 — where the breaker would land.**

`B4.6` (in `04-agents-and-tool-use/06-error-recovery.md`) sketches the implementation: a `lib/agents/circuit-breaker.ts` that wraps `AnthropicModelProviderAdapter.complete()` with state (CLOSED / OPEN / HALF-OPEN) + counter + timer. A second instance could wrap `BloomreachDataSource.callTool` for the Bloomreach outage case.

Two breakers, two failure modes:

  → **Anthropic breaker.** Anthropic API outage. Sonnet returns 5xx; breaker opens after N consecutive failures.
  → **Bloomreach breaker.** Bloomreach MCP server outage. `McpToolError` thrown N times consecutively; breaker opens.

Each breaker is independent — Bloomreach down doesn't open Anthropic's breaker.

**Part 4 — why not just lower `maxRetries` to 1?**

Lowering retries to 1 reduces the worst-case wall-clock (30s → 10s) but loses the transient-failure recovery. A circuit breaker keeps `maxRetries = 3` (good for transient failures) AND avoids hammering during sustained failures. The patterns layer; they don't substitute.

### Move 3 — the principle

**Retry handles brief; circuit breaker handles sustained.** Each pattern alone is incomplete — pure retry burns time on every request during an outage; pure circuit breaker fails too easily on a single transient blip. Layered, you get fast recovery from blips AND fast errors from outages. This codebase has the first half; `B4.6` is the second half.

## Primary diagram — the full recap

```
  Retry + circuit breaker, layered

  ┌─ Circuit state check (would be here, not shipped) ───────────┐
  │  if state == OPEN: throw CircuitOpenError immediately        │
  │  if state == HALF-OPEN: allow one trial                      │
  │  if state == CLOSED: proceed                                 │
  └──────────────────────────────────────────────────────────────┘
                         │
                         ▼
  ┌─ Live call (shipped) ────────────────────────────────────────┐
  │  proactive spacing (1.1s)                                     │
  │  transport.callTool(name, args)                              │
  │  if rate-limited: retry up to 3 times                         │
  │  if other error: throw                                       │
  └──────────────────────────────────────────────────────────────┘
                         │
                         ▼
  ┌─ Result envelope ────────────────────────────────────────────┐
  │  { result, durationMs, fromCache }                           │
  └──────────────────────────────────────────────────────────────┘
                         │
                         ▼
  ┌─ Circuit state update (would be here, not shipped) ──────────┐
  │  on success: failure_count = 0; if HALF-OPEN → CLOSED        │
  │  on failure: failure_count++;                                │
  │   if failure_count >= threshold and within window:           │
  │     state = OPEN; schedule HALF-OPEN after T seconds         │
  └──────────────────────────────────────────────────────────────┘

  Shipped today: the middle block only (retry layer).
  Missing: the wrapping circuit-state checks above and below.
```

## Elaborate

**Why exponential backoff specifically.** Constant-interval retry (wait 5s every time) is bad because if the server is overloaded, you join a synchronized chorus of clients retrying every 5 seconds — making things worse. Exponential backoff spreads out retries over time, reducing the chance of synchronized waves. The `2^retry` doubling is the standard shape.

**Where jitter would help.** Multiple agents in the same `BloomreachDataSource` instance won't have synchronized retries (the retry happens inside one `callTool` invocation, which is sequential). But once `B6.4` (cross-session rate limiter) lands, multiple instances could synchronize on the shared KV-based timer. Adding ±20% jitter to retry waits is a small change that defends against this.

**Where this codebase's retry might bite.** Three known cases:

  1. **Bloomreach OAuth expiry.** A 401 from "token expired" isn't a rate limit, isn't transient — retry doesn't help. The McpToolError is thrown immediately and the route's auto-reconnect logic kicks in.
  2. **Schema validation failures.** If the model emits malformed `tool_use.input`, the MCP server rejects it. Retry doesn't help — the same malformed input on retry fails identically. Today, this just times out 3 retries and throws. A smarter pattern would skip retry for `4xx`-like errors (caller's fault, not server's fault). Not currently distinguished.
  3. **The route's 300s budget.** If 6 tool calls × 3 retries × 10-20s each occur, the route can hit 300s and Vercel terminates. The per-phase log catches this in `finally`.

## Project exercises

### Exercise — Distinguish 4xx (caller fault) from 5xx (server fault) in retry logic

  → **Exercise ID:** B6.5
  → **What to build:** Extend `BloomreachDataSource.callTool` to inspect the error envelope. If the error is a 4xx-shaped failure (malformed request, schema validation), skip retry — throw immediately. If 5xx-shaped (server error, rate limit), retry as today. Surface the distinction in the McpToolError detail.
  → **Why it earns its place:** today, an LLM hallucinating a bad tool input pays 30s of retry wall-clock per call before failing. A 4xx-skip-retry policy collapses that to ~1s. Small change with real latency payoff on a known failure mode.
  → **Files to touch:** `lib/data-source/bloomreach-data-source.ts` (extend `isRateLimited` to a more nuanced `shouldRetry` check), `test/data-source/bloomreach-data-source.test.ts` (cover 4xx-no-retry, 5xx-retry, rate-limit-retry).
  → **Done when:** a synthetic 4xx failure (bad schema) throws within 1s, a 5xx failure still gets 3 retries, a rate-limit failure still gets the parsed-window retry, and the per-call telemetry distinguishes the three outcomes.
  → **Estimated effort:** 1–4hr.

## Interview defense

**Q: "What's your retry logic?"**

Inside `BloomreachDataSource.callTool`: when a result comes back as rate-limited (parsed from the error text), retry up to 3 times. Each wait is the *hint-first* — if the server says "retry after 12 seconds," wait 12.5s. If no parseable hint, exponential backoff starting at 10s (Bloomreach's observed penalty window). Every wait is capped at 20s. No jitter today because there's only one client per `BloomreachDataSource` instance (per-session). When the cross-session rate limiter lands (`B6.4`), jitter becomes relevant.

No circuit breaker. Sustained outages cost users 30s per request before failing — bad UX. `B4.6` is the circuit breaker design.

*Anchor: "Hint-first retry with 20s ceiling; no jitter today; circuit breaker is `B4.6`."*

**Q: "What's missing from your production resilience?"**

Circuit breaker. Today, when Bloomreach is down for 5 minutes, every new request burns ~30s in retries before failing — the user waits and then sees the error. With a circuit breaker, after 5 consecutive failures the circuit opens and new requests fail fast (<100ms) for the next 60s. After the 60s timeout, half-open: try one. Success → close. Failure → re-open. Big UX improvement during sustained outages; small wall-clock change during transient blips.

The design lives in `B4.6`. I'd implement two breakers: one wrapping the Anthropic call (handles Anthropic outages), one wrapping the Bloomreach call (handles Bloomreach outages). Independent failure modes; independent breakers.

*Anchor: "Circuit breaker is the big missing piece; two breakers (Anthropic + Bloomreach), independent."*

## See also

  → `04-rate-limiting-backpressure.md` — the rate-limit story this retry serves
  → `04-agents-and-tool-use/06-error-recovery.md` — the broader error-recovery framing; `B4.6` lives here
  → `study-system-design/10-rate-limit-aware-mcp-client.md` — the same retry logic from the system-design lens

# Rate-limit spacing + bounded retry

**Industry name(s):** client-side request throttling (fixed-interval spacing), retry-with-fixed-backoff, bounded retry
**Type:** Industry standard · Language-agnostic

> `McpClient` enforces a minimum gap between every outbound MCP call and wraps each call in a bounded retry loop so a transient 429 never kills an agent run.

**See also:** → 01-ttl-cache.md · → ../01-system-design/04-caching-and-rate-limiting.md

---

## Why care

Your autocomplete input fires a `fetch` on every keystroke. After three fast keystrokes the server returns 429s. You reach for `debounce` to stop the flood, and when a call still slips through and 429s you retry it — capped at three attempts so it can't spin forever.

The question is: **how does a client guarantee a minimum gap between live calls AND recover from a transient rate-limit hit without spinning forever?**

**Bloomreach enforces ~1 req/sec per user GLOBALLY.** A single briefing agent fires 6–13 sequential MCP calls. Without spacing, back-to-back calls arrive at Bloomreach faster than 1/sec and trip "Too many requests." Without bounded retry, one transient 429 kills the entire briefing run. With unbounded retry, a persistent limit could spin the loop indefinitely.

It is a `throttle` + bounded fixed-delay backoff, inside one client method.

---

## How it works

Every live call passes through a spacing gate that delays it until the minimum interval has elapsed, and the result feeds a bounded retry loop that re-enters that same gate on a 429-equivalent response.

```
  callTool
      │
  ┌───▼─────────────────────────────────┐
  │  spacing gate (liveCall)             │
  │  elapsed < minIntervalMs? → wait     │
  └───┬─────────────────────────────────┘
      │
  ┌───▼─────────────────────────────────┐
  │  transport.callTool → result         │
  └───┬─────────────────────────────────┘
      │
  ┌───▼─────────────────────────────────┐
  │  isRateLimited(result)?              │
  │  yes + retries < maxRetries          │
  │    → sleep(retryDelayMs)             │
  │    → back to spacing gate            │
  │  no / exhausted → return result      │
  └─────────────────────────────────────┘
```

The retry loop re-enters the spacing gate, so every retry also waits the minimum interval.

### Isolate the kernel

Spacing + bounded retry has an irreducible kernel: four parts that *are* the pattern. Strip anything else and you still have a working flow-controlled caller; strip any of these and you don't.

```
callTool(name, args):
  // SPACING
  elapsed = Date.now() - lastCallAt                  ─┐
  if elapsed < minIntervalMs:                         │
    await sleep(minIntervalMs - elapsed)              │  KERNEL
  result = transport.call(name, args)                 │
  lastCallAt = Date.now()                             │
                                                       │
  // BOUNDED RETRY                                    │
  while isRateLimited(result) and retries++ < max:    │
    await sleep(parsedHint ?? backoff, capped at ceil)│
    result = transport.call(...)                      │
  return result                                      ─┘
```

Four load-bearing pieces: the inter-call spacing gate, the `lastCallAt` clock, the rate-limit detector, and the bounded retry with a backoff cap. No jitter, no per-tool circuit-breaker, no token bucket — those are *hardening*.

---

### Name each part by what breaks when removed

Each kernel piece is here because something specific breaks if you drop it.

```
Removed                                What breaks
─────────────────────────────         ─────────────────────────────────────
elapsed < minIntervalMs wait          The first three calls fire in <300 ms,
                                      the server 429s every subsequent one,
                                      and the retry loop kicks in for ALL of
                                      them. The whole budget is spent on
                                      retries that wouldn't have been needed.

lastCallAt update                     The clock never moves. elapsed stays
                                      huge. The gate becomes a no-op and the
                                      first failure mode returns.

isRateLimited detection               A real 429 (returned, not thrown) flows
                                      back to the caller as a "successful"
                                      result — no retry, no error logged.
                                      The caller silently processes garbage.

maxRetries cap                        A permanently-down endpoint loops the
                                      retry forever, burning the 300s function
                                      budget on a tool that isn't coming back.
                                      One dead tool = the whole request dies.

retryCeilingMs cap on backoff         Exponential growth means retry 3 sleeps
                                      40 s, retry 4 sleeps 80 s, etc. — past
                                      the function timeout, the response is
                                      gone before the retry returns.
```

The four parts compose: spacing PREVENTS most 429s; detection RECOGNIZES the ones it can't prevent; bounded retry HANDLES them; the ceiling KEEPS the handling inside the function budget. Drop any one and the chain breaks at a different place.

---

### Separate skeleton from optional hardening

The kernel is the minimum. The codebase ships some hardening on top and omits the rest, and naming which is which is part of the pattern.

```
SKELETON (in McpClient — required)             HARDENING
────────────────────────────────────           ────────────────────────────────
elapsed < minIntervalMs spacing gate           ┌ jitter on retry sleeps   (absent)
lastCallAt single-state clock                  ├ per-tool circuit breaker (absent)
isError + regex 429 detection                  ├ token-bucket limiter     (absent)
bounded retry counter (maxRetries)             ├ adaptive backoff that
backoff cap (retryCeilingMs)                   │   reads the server's
no-cache-on-error guard (cross-cuts            │   capacity hint         (absent)
  with the TTL-cache file — same write site)   └ parsed Retry-After hint  (PRESENT,
                                                  via parseRetryAfterMs)
```

The codebase has exactly one piece of optional hardening — `parseRetryAfterMs` (`lib/mcp/client.ts` L31–L38), which prefers a window parsed from the Bloomreach error text when present and falls back to exponential backoff otherwise. It deliberately omits jitter (single user, no thundering-herd risk at this scale), a per-tool breaker (one upstream, no tool-isolation needed), and a token bucket (the simple counter holds at one user under a 1 req/s limit). The breakpoints that flip any of those choices live in Tradeoffs.

---

### Step-by-step execution trace

Scenario: `minIntervalMs = 1100`, `maxRetries = 3`, `retryDelayMs = 1200`. Call 1 arrives at wall-clock T=0. Call 2 arrives at T=300. Call 3's first attempt returns a rate-limit result but the retry succeeds.

**Call 1 — enters `liveCall` at T=0:**

| Variable | Value | Note |
|---|---|---|
| `Date.now()` | 0 | wall clock at gate entry |
| `lastCallAt` | 0 | initial value |
| `elapsed` | 0 | `0 - 0 = 0` |
| wait? | no | `0 < 1100` is false (0 is not < 1100... wait: 0 < 1100 is TRUE, but `elapsed = 0` and the field was never written, so `Date.now() - 0` = current epoch ms ≫ 1100) |

Correction — `lastCallAt` starts at `0` (Unix epoch). `Date.now()` is ~1.7 trillion. `elapsed` is enormous → no wait. Transport called immediately. `lastCallAt` set to T=5 ms (round trip).

**Call 2 — enters `liveCall` at T=300:**

| Variable | Value |
|---|---|
| `Date.now()` | 300 |
| `lastCallAt` | 5 |
| `elapsed` | `300 - 5 = 295 ms` |
| `295 < 1100?` | yes |
| wait | `1100 - 295 = 805 ms` |
| resumes at | T ≈ 1105 ms |
| transport called | T ≈ 1105 ms |
| `lastCallAt` after | ≈ 1110 ms |

**Call 3 — enters `callTool`, first `liveCall` attempt at T=1200:**

| Variable | Value |
|---|---|
| `Date.now()` at gate | 1200 |
| `lastCallAt` | 1110 |
| `elapsed` | `1200 - 1110 = 90 ms` |
| `90 < 1100?` | yes → wait 1010 ms |
| resumes at | T ≈ 2210 ms |
| `result` | `{ isError: true, content: "rate limit reached" }` |
| `isRateLimited(result)` | `true` |
| `retries` | 0 → incremented to 1 |
| `retries < maxRetries (3)?` | yes |
| `sleep(1200)` | waits until T ≈ 3410 ms |

**Call 3 — retry 1, enters `liveCall` at T=3410:**

| Variable | Value |
|---|---|
| `Date.now()` at gate | 3410 |
| `lastCallAt` | 2215 (set when first attempt returned) |
| `elapsed` | `3410 - 2215 = 1195 ms` |
| `1195 < 1100?` | no → no wait |
| transport called | T ≈ 3410 ms |
| `result` | `{ isError: false, content: [...] }` |
| `isRateLimited(result)` | `false` |
| loop exits | `retries = 1`, result returned |

### The principle

Fix the call rate by delaying each call until a minimum interval has passed from the last one. Cap the retry count so a persistent failure terminates rather than spinning. Both policies are enforced inside `liveCall`, so retries automatically inherit the spacing.

---

## Rate-limit spacing + bounded retry — diagram

Full path from `callTool` entry to result. Stands alone.

```
  ┌──────────────────────────────────────────────────────────────────┐
  │  McpClient                                                        │
  │                                                                   │
  │  callTool(name, args)                                             │
  │       │                                                           │
  │  ┌────▼──────────────────────────────────────────────────────┐   │
  │  │  liveCall — spacing gate                                   │   │
  │  │                                                            │   │
  │  │  elapsed = Date.now() - lastCallAt                        │   │
  │  │       │                                                    │   │
  │  │  elapsed < minIntervalMs (1100 ms)?                       │   │
  │  │  ┌────┴────┐                                              │   │
  │  │  │ yes     │ no                                           │   │
  │  │  ▼         │                                              │   │
  │  │  wait      │                                              │   │
  │  │  (1100-elapsed) ms                                        │   │
  │  │       └────▼                                              │   │
  │  │  transport.callTool(name, args)  ── network call ──────▶  │   │
  │  │  lastCallAt = Date.now()          ◀──────────────────────  │   │
  │  └────────────────────────┬──────────────────────────────────┘   │
  │                           │ result                                │
  │  ┌────────────────────────▼──────────────────────────────────┐   │
  │  │  retry loop                                                │   │
  │  │                                                            │   │
  │  │  isRateLimited(result) && retries < maxRetries (3)?       │   │
  │  │  ┌────┴────┐                                              │   │
  │  │  │ yes     │ no                                           │   │
  │  │  ▼         ▼                                              │   │
  │  │  retries++ return result                                  │   │
  │  │  sleep(parsed hint, else retryDelayMs*2^(n-1), capped)    │   │
  │  │  → back to liveCall (spacing gate runs again)             │   │
  │  └────────────────────────────────────────────────────────────┘   │
  └──────────────────────────────────────────────────────────────────┘
```

`isRateLimited` checks `result.isError === true` AND `/rate limit|too many requests/i` on the serialized content. Detection is on the result object, not a thrown exception.

---

## In this codebase

**File:** `lib/mcp/client.ts`
**Function / class:** `McpClient.callTool` + `liveCall` + `isRateLimited` + `parseRetryAfterMs`
**Line range:** L18–L163

```typescript
// lib/mcp/client.ts  L18–L22 — detection
function isRateLimited(result: unknown): boolean {
  if (!result || typeof result !== 'object' || (result as any).isError !== true) return false;
  const text = JSON.stringify((result as any).content ?? result);
  return /rate limit|too many requests/i.test(text);
}

// lib/mcp/client.ts  L148–L163 — spacing gate (with transport-error tagging)
private async liveCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  try {
    const result = await this.transport.callTool(name, args);
    this.lastCallAt = Date.now();
    return result;
  } catch (err) {
    this.lastCallAt = Date.now();
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}

// lib/mcp/client.ts  L121–L132 — bounded retry loop (parsed-hint / exponential backoff, capped)
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
  result = await this.liveCall(name, args);
}
```

The 1100 ms value (and retry tuning) is set in `lib/mcp/connect.ts` L91–L96:
```typescript
mcp: new McpClient(new SdkTransport(client, httpErrors), {
  minIntervalMs: 1100,
  retryDelayMs: 10_000,
  retryCeilingMs: 20_000,
  maxRetries: 3,
}),
```

**GitHub links:**
- `liveCall` (L148–L163): https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/client.ts#L148-L163
- retry loop (L121–L132): https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/client.ts#L121-L132
- `isRateLimited` (L18–L22): https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/client.ts#L18-L22
- `connect.ts` 1100 ms (L91–L96): https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/connect.ts#L91-L96

---

## Elaborate

### Where it comes from

**Token bucket / leaky bucket lineage.** The canonical server-side rate-limiting algorithms are the token bucket (allow bursts up to bucket capacity, refill at a fixed rate) and the leaky bucket (drain at a fixed rate, smooth all bursts). Both are server-side enforcement mechanisms. Client-side throttling is a complementary pattern: the client voluntarily reduces its call rate to stay under a known server limit, avoiding 429s entirely.

**Fixed-interval spacing** is the simplest client throttle: no more than one call per `minIntervalMs`. There is no credit accumulation, no bucket, no burst. It is equivalent to a leaky bucket with capacity = 1 where the drain rate is 1/`minIntervalMs`.

**Bounded retry with backoff** is the standard retry policy. The codebase prefers a wait window parsed out of the Bloomreach error text and otherwise applies exponential backoff (`retryDelayMs * 2 ** (retries - 1)`) capped at `retryCeilingMs`. What it omits is jitter (`+ random(0, jitter)`): without it, multiple callers that all retry at the same moment still wake together — a synchronized thundering herd.

### The deeper principle

A spacing gate and a retry loop are two separate concerns composed in sequence:

```
  ┌─────────────────────────────────────────────────────────┐
  │  Proactive policy (spacing gate)                         │
  │  Goal: never trigger a 429 in the first place           │
  │  Mechanism: enforce minimum inter-call gap              │
  └─────────────────────────────────────────────────────────┘
                         +
  ┌─────────────────────────────────────────────────────────┐
  │  Reactive policy (bounded retry)                         │
  │  Goal: recover from transient 429s that slip through    │
  │  Mechanism: detect on result, sleep, retry, cap         │
  └─────────────────────────────────────────────────────────┘
```

The proactive policy handles steady-state. The reactive policy handles edge cases (server-side jitter, clock skew, multi-instance races). Together they make the happy path reliable and the failure path bounded.

### Where it breaks down

**Fixed delay is not a true token bucket.** A token bucket accumulates credit during idle periods and spends it during bursts. After 5 seconds of silence, a token bucket at 1 req/sec has 5 credits and can legitimately fire 5 calls in quick succession. `liveCall`'s fixed delay never accumulates credit — even after 60 seconds of silence, call 1 goes immediately but call 2 must wait 1100 ms. This is unnecessarily conservative.

**Per-process `lastCallAt` does not coordinate across instances.** `lastCallAt` is a field on `McpClient`. Each call to `connectMcp` (`lib/mcp/connect.ts` L91–L96) creates a new `McpClient` with its own `lastCallAt = 0`. Two concurrent serverless invocations for the same user each see `lastCallAt = 0` and both call the transport simultaneously — 2 req/sec against a 1 req/sec global quota.

**Backoff has no jitter.** The wait is exponential off `retryDelayMs` (or a parsed retry-after window), capped at `retryCeilingMs` — but it adds no random jitter. If 10 callers all receive a 429 at T=0, they all compute the same wait and retry at the same instant — a synchronized burst. Full jitter (add `random(0, delay)` ms) spreads them out.

### What to explore next

- **Token bucket algorithm** (`Bottleneck`, `p-throttle` npm packages) — allows bursts proportional to idle time while respecting the average rate.
- **Exponential backoff with full jitter** — `delay = random(0, base * 2^attempt)`; the AWS whitepaper "Exponential Backoff And Jitter" (2015) is the reference.
- **Distributed rate limiting** (Upstash Rate Limit, Redis sliding window) — replaces per-process `lastCallAt` with a shared atomic counter visible to all instances.

---

## Tradeoffs

### Comparison: fixed spacing + jitterless backoff bounded retry vs. alternatives

| Dimension | This codebase (fixed gap + exp backoff, no jitter) | Token bucket + exp backoff w/ jitter |
|---|---|---|
| Complexity | Zero deps; one timestamp field; one loop counter; backoff + cap math | `Bottleneck` or custom bucket + random jitter math |
| Burst handling | None — every inter-call gap is ≥ 1100 ms regardless | Allows bursts when credit has accumulated |
| Thundering herd on retry | Yes — all retries compute the same wait and wake simultaneously | No — jitter spreads wakeups across a window |
| Cross-instance coordination | No — per-process `lastCallAt` only | Still no (needs Redis for distributed coordination) |
| Correct under single-process steady load | Yes | Yes |
| State to tune | `minIntervalMs`, `maxRetries`, `retryDelayMs`, `retryCeilingMs` | Bucket capacity, refill rate, backoff base, jitter cap |

**Gave up:**
- **Burst absorption.** After 10 seconds of silence the client could legitimately fire 10 requests in succession and still average 1/sec. The fixed delay blocks this even when it is safe.
- **Jitter on retry.** The backoff is deterministic, so concurrent callers that hit a 429 together compute identical waits and produce a synchronized retry wave.

**Alternative's cost:**
- A real token bucket (`Bottleneck`, `p-throttle`) adds a package dependency and configuration surface (`reservoir`, `reservoirRefreshInterval`, `maxConcurrent`) that is disproportionate to the current single-process, single-user target.
- Adding jitter on top of the existing backoff requires tuning a jitter cap; for three retries the benefit is minimal — the complexity is not worth it until retry storms are observed.

**Breakpoint:**
This design is correct for one process serving one user at a flat ~1 req/sec. It needs a token bucket + distributed coordination the moment multiple concurrent serverless instances share one user's Bloomreach rate-limit quota.

---

## Tech reference (industry pairing)

### setTimeout-promise spacing

- **`Bottleneck`** (npm) — industry leader for Node.js rate limiting. Supports token bucket (`reservoir`), concurrency cap (`maxConcurrent`), priority queues. Drop-in replacement for `liveCall`'s spacing logic with burst support.
- **`p-throttle`** (npm) — lightweight fixed-rate throttle for promise-returning functions. Single-purpose: N calls per interval. Direct analogue to `minIntervalMs`.
- **`p-limit`** (npm) — concurrency limiter, not a rate limiter. Use when the constraint is max concurrent calls, not calls per second.
- **`async-throttle`** / **`throat`** (npm) — runner-ups for simpler throttle use-cases; fewer features than Bottleneck, more than p-throttle.
- **Upstash Rate Limit** (`@upstash/ratelimit`) — Redis-backed, works across serverless instances. The production fix when `lastCallAt` can no longer be per-process.

### bounded retry

- **`p-retry`** (npm) — industry standard for retrying promise-returning operations. Supports `retries`, `minTimeout`, `maxTimeout`, exponential factor, jitter, custom `onFailedAttempt` hook. Direct replacement for the `while (isRateLimited)` loop.
- **`cockatiel`** (npm) — resilience library: retry, circuit breaker, timeout, fallback, bulkhead. Use when retry alone is insufficient and you need circuit-breaking to stop hammering a dead service.
- **`axios-retry`** — automatic retry plugin for Axios HTTP clients. Handles 429 and 5xx with configurable exponential backoff. Runner-up when the HTTP client is Axios.
- **`fetch-retry`** (npm) — wraps `fetch` with retry. Zero-dependency, minimal API. Runner-up for simple fetch-based cases.
- **AWS SDK v3 retry behavior** — built-in exponential backoff with full jitter, the reference implementation. Documented in the AWS whitepaper "Exponential Backoff And Jitter" (2015); directly informs `p-retry` defaults.

---

## Summary

`McpClient.liveCall` enforces a minimum inter-call gap by computing `elapsed = Date.now() - lastCallAt` and sleeping the deficit before every transport call. `callTool` wraps `liveCall` in a bounded `while (isRateLimited && retries < maxRetries)` loop whose sleep is a parsed retry-after window or exponential backoff off `retryDelayMs`, capped at `retryCeilingMs`. Defaults in `lib/mcp/connect.ts`: `minIntervalMs = 1100`, `maxRetries = 3`, `retryDelayMs = 10_000`, `retryCeilingMs = 20_000`.

- `liveCall` (`lib/mcp/client.ts` L148–L163) is the only entry point to the transport; every live call — initial and retry — passes through the spacing gate
- `lastCallAt` (`lib/mcp/client.ts` L81) is the only state the spacing gate needs; it is set after the transport returns, measuring gap from end of previous call not start
- `isRateLimited` (`lib/mcp/client.ts` L18–L22) inspects the result object (not a thrown exception) for `isError === true` plus a text match on `/rate limit|too many requests/i`
- The retry loop (`lib/mcp/client.ts` L121–L132) caps at `maxRetries` retries; total possible transport calls per `callTool` invocation is `maxRetries + 1`
- Fixed interval spacing is not a token bucket — no burst credit accumulates; per-process `lastCallAt` breaks under horizontal scaling; the exponential backoff carries no jitter, so concurrent retries can wake together

---

## Interview defense

### What they are really asking

"How does this client avoid hitting the rate limit?" is asking whether you understand the difference between proactive throttling (prevent 429s) and reactive retry (recover from them), whether you know the per-process limitation of `lastCallAt`, and whether you have considered what happens under concurrent load.

### Q + A

**[mid] How does `liveCall` enforce the 1.1-second gap?**

It reads `elapsed = Date.now() - this.lastCallAt`. If `elapsed < minIntervalMs`, it awaits `new Promise(r => setTimeout(r, minIntervalMs - elapsed))` — a `setTimeout`-promise, the same primitive as a manually awaited sleep. After the transport returns, it sets `lastCallAt = Date.now()`. The gap is from end-of-last-call to start-of-next-call.

```
  T=0   liveCall A enters gate
        elapsed = huge (lastCallAt=0) → no wait
        transport.callTool()
        lastCallAt = T=5

  T=300 liveCall B enters gate
        elapsed = 295 ms  →  wait 805 ms
        transport.callTool() at T=1105
        lastCallAt = T=1110
```

**[senior] `isRateLimited` inspects the result, not a caught exception. Why?**

The MCP transport does not throw on a 429; it returns a structured result object with `isError: true`. Relying on a `try/catch` would miss this entirely. The check is on the shape of the returned data: `result.isError === true` AND the serialized content matches `/rate limit|too many requests/i` (`lib/mcp/client.ts` L18–L22). This design means the retry logic is decoupled from exception handling — it works regardless of whether the transport throws or returns structured errors.

```
  result arrives
       │
  result.isError === true?
  ┌────┴────┐
  │ yes     │ no → not an error, skip retry entirely
  ▼
  stringify(content ?? result)
  matches /rate limit|too many requests/i?
  ┌────┴────┐
  │ yes     │ no → some other error, skip retry
  ▼
  trigger retry loop
```

**[arch] Does the 1100 ms spacing guarantee the rate limit across multiple serverless instances?**

No. `lastCallAt` is a field on `McpClient` which is created fresh per `connectMcp` call (`lib/mcp/connect.ts` L91–L96). Two concurrent serverless invocations for the same user each have `lastCallAt = 0`. Both compute `elapsed = Date.now() - 0` = enormous → no wait → both call the transport simultaneously. Bloomreach sees 2 req/sec.

```
  Instance A:  lastCallAt = 0 → liveCall at T=0  ──▶  transport
  Instance B:  lastCallAt = 0 → liveCall at T=0  ──▶  transport
                                                        ↑ 2 concurrent calls,
                                                          1 req/sec quota violated
```

Fix: a shared atomic counter in Redis (sliding window or token bucket) that all instances read and decrement before calling the transport.

### The dodge

**"Why a fixed 1.1 s gap instead of a token bucket that allows bursts?"**

Honest answer: it is the simplest correct solution for one process. A token bucket accumulates credit during idle periods; a fixed interval does not. For a single serverless function handling sequential briefing calls, there are no idle periods during a run — every 1.1 s gap is real back-pressure, not wasted credit. The token bucket's burst advantage only matters when calls arrive in clusters after silence, which is not the steady-state briefing pattern. The comment block in `connect.ts` L81–L88 explains this deliberate choice — proactive spacing stays at ~1.1 s while the parsed retry window absorbs the full penalty.

```
  Fixed delay (current):
  ────┬─────────────┬─────────────┬─────────────▶  time
      call          call          call
      │◀── 1100 ms ─▶│◀── 1100 ms ─▶│
      strictly 1 call per 1.1 s, even after 60 s of silence

  Token bucket (alternative, capacity=3, refill 1/s):
  ────┬──┬──┬───────────────┬──┬──┬─────────────▶  time
      calls (burst)          calls (burst after refill)
      │       average still ≤ 1/s; bursts allowed
```

Both respect the average rate. The token bucket is better when the call pattern is bursty. The fixed delay is simpler and sufficient for the current linear briefing pattern.

### Anchors

- `lib/mcp/client.ts` L18–L22 — `isRateLimited`: two-condition detection on result, not exception
- `lib/mcp/client.ts` L81 — `lastCallAt = 0`: per-instance state, the source of multi-instance races
- `lib/mcp/client.ts` L121–L132 — retry loop: `retries < maxRetries`, parsed-hint / exponential backoff, re-enters `liveCall`
- `lib/mcp/client.ts` L148–L163 — `liveCall`: spacing gate, `setTimeout`-promise, `lastCallAt` update
- `lib/mcp/connect.ts` L91–L96 — `minIntervalMs: 1100` (and retry tuning) with rate-limit comment explaining the 1 req/sec constraint

---

## Validate your understanding

### Level 1 — reconstruct

Without looking at the code, write the `liveCall` function from memory. Name the one field it reads, the one field it writes, and the one branch it sleeps in. Then write the retry loop: what is the loop condition, what happens inside the loop body, and what does `isRateLimited` test for?

### Level 2 — explain (cite `lib/mcp/client.ts`)

Open `lib/mcp/client.ts` L121–L132. The retry loop calls `this.liveCall(name, args)` — not `this.transport.callTool(name, args)` directly. Why? What would break if the retry bypassed `liveCall` and called the transport directly? Cite L148–L163 in your answer.

### Level 3 — apply

Scenario: calls are still receiving occasional 429s even with 1100 ms spacing. Diagnose.

- First: is the spacing working per-process? How would you verify — what log lines or test would confirm `elapsed` is always ≥ 1100 ms? Cite `lib/mcp/client.ts` L149.
- Second: does the retry recover the call when a 429 does arrive? Trace the loop at L121–L132 for `maxRetries = 3`: how many transport calls can a single `callTool` invocation make? What is the maximum total wall-clock time those calls can consume (include the capped backoff sleeps and `minIntervalMs` waits)?
- Third: now add a second process. Both processes share the same Bloomreach user quota. Explain — citing `lib/mcp/client.ts` L81 and `lib/mcp/connect.ts` L91–L96 — why the per-process spacing provides no protection against inter-process collisions. What change to the architecture would fix this?

### Level 4 — defend

The retry loop already prefers a parsed retry-after window and otherwise applies exponential backoff (`retryDelayMs * 2 ** (retries - 1)`) capped at `retryCeilingMs` — but it adds no jitter. For `retryDelayMs = 10_000`, `retryCeilingMs = 20_000`, `maxRetries = 3`, write out the (capped) backoff-only schedule:

- Backoff (no hint): 10_000 ms, 20_000 ms (capped), 20_000 ms (capped)

Under what conditions does the parsed-hint path beat the raw backoff? Is jitter (`delay + random(0, delay/2)`) worth adding here for a single-process, single-user deployment, or only once multiple instances can collide? Anchor your answer to the deployment target documented in `lib/mcp/connect.ts` L12–L14.

### Quick check

- How many total transport calls does `maxRetries = 3` allow for one `callTool` invocation? (Initial call + 3 retries = 4 total.)
- `isRateLimited` requires two conditions. Name both. (Cite `lib/mcp/client.ts` L19–L21.)
- `lastCallAt` is set AFTER the transport returns, not before. Why does this matter for the gap measurement? (Gap is from end of last network call, not from when the next call was queued.)
- What is the default `minIntervalMs` on the `McpClient` constructor, and what value does `connect.ts` override it to? (200 ms default per `lib/mcp/client.ts` L88; 1100 ms in `lib/mcp/connect.ts` L92.)
- Does the retry loop re-enter the spacing gate? (Yes — it calls `liveCall`, not the transport directly; cite `lib/mcp/client.ts` L131.)

---
Updated: 2026-05-28 — refreshed code references to current line numbers; retry now prefers a parsed retry-after window / exponential backoff capped at `retryCeilingMs` (defaults `retryDelayMs = 10_000`, `retryCeilingMs = 20_000`)
Updated: 2026-05-30 — Applied study.md v1.46 Move-2-variant (load-bearing skeleton: isolate the kernel + what-breaks-if-removed + skeleton vs hardening) to How it works.

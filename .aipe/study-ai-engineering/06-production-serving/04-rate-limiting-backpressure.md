# Rate limiting and backpressure

*Industry standard — proactive spacing · retry-on-429 · backpressure*

## Zoom out — where this concept lives

Bloomreach's loomi connect alpha MCP server rate-limits per user globally at ~1 req/s (sometimes stated as ~1 per 10 second in 429 messages). This codebase defends with two layers: **proactive spacing** (~1.1s between calls inside `BloomreachDataSource`) and **parsed-window retry** (when a 429 comes through anyway, parse the stated penalty window from the error text, wait, retry). Anthropic isn't rate-limited at scales this codebase hits today.

```
  Zoom out — rate-limit defense layers

  ┌─ Agent loop ────────────────────────────────────────────┐
  │  agent calls dataSource.callTool many times             │
  └──────────────────────┬──────────────────────────────────┘
                         │
                         ▼
  ┌─ ★ BloomreachDataSource (the defense) ★ ────────────────┐ ← we are here
  │  proactive: sleep until 1.1s since last call             │
  │  retry: parse the server's "per N seconds" hint,         │
  │          wait + 500ms buffer, retry (max 3)              │
  │  cache: 60s response cache absorbs repeats               │
  └──────────────────────┬──────────────────────────────────┘
                         │
                         ▼
  ┌─ Bloomreach MCP server ─────────────────────────────────┐
  │  ~1 req/s per user globally                              │
  │  429 with stated window when violated                    │
  └─────────────────────────────────────────────────────────┘
```

**Zoom in.** This is the most defensively-engineered part of the codebase because the Bloomreach alpha server is the codebase's most-rate-limited dependency. Three defense layers compose — cache reduces calls, proactive spacing prevents 429s, retry recovers from any 429s that slip through.

## Structure pass — layers · axes · seams

**Layers:** agent → DataSource → MCP server.

**Axis: where does each defense apply?**
  → Cache: at the DataSource entry (skip the call entirely if cached).
  → Proactive spacing: between DataSource calls (delay the next call until 1.1s elapsed).
  → Retry: after a failed call (wait + retry up to 3 times).

**Seam:** every defense is inside `BloomreachDataSource` (`lib/data-source/bloomreach-data-source.ts`). The agent layer never sees rate limits.

## How it works

### Move 1 — the mental model

You know how a polite client waits between requests instead of bursting, and falls back gracefully when told "slow down"? Same shape. Proactive spacing = polite by default. Retry = graceful recovery when politeness wasn't enough.

```
  Three layered defenses, in order

  Layer 1: cache (60s response cache)
   ─────────────────────────────────
   Most "calls" never reach the server — duplicates within
    60s return the cached result.

  Layer 2: proactive spacing (1.1s between live calls)
   ──────────────────────────────────────────────────
   When a live call IS needed, wait until enough time has
    elapsed since the last live call.

  Layer 3: parsed-window retry (when 429 happens anyway)
   ─────────────────────────────────────────────────────
   The agent's tool selection sometimes bursts; or another
    session on the same instance bursts; or the server's
    window is tighter than expected. Retry up to 3 times,
    waiting the server's stated window + 500ms buffer.
```

### Move 2 — the step-by-step walkthrough

**Part 1 — proactive spacing.**

`BloomreachDataSource.liveCall` at `lib/data-source/bloomreach-data-source.ts:180-189`:

```typescript
private async liveCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  try {
    const result = await this.transport.callTool(name, args, { signal });
    this.lastCallAt = Date.now();
    return result;
  } catch (err) {
    this.lastCallAt = Date.now();
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}
```

`minIntervalMs = 1100` (set at `lib/mcp/connect.ts:105`). Before every live call, check `(Date.now() - lastCallAt)`. If under 1100ms, sleep the difference. `lastCallAt` updates both on success AND on error — a failed call still counts toward the rate.

The choice of 1100ms (not 1000ms exactly): 100ms of buffer above the server's stated `1 per 1 second` window to avoid landing on the boundary.

**Part 2 — parsed-window retry.**

When a call comes back as `isError: true` AND the result text matches `/rate limit|too many requests/i`, the retry loop kicks in at `lib/data-source/bloomreach-data-source.ts:153-170`:

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

Three things to notice:

  → **Hint parsing** (`parseRetryAfterMs` at line 62-69) reads two shapes from the error text: `"Retry after ~12 second(s)"` → 12_000ms, and `"rate limit reached (1 per 10 second)"` → 10_000ms.
  → **Hint wins over backoff.** When a hint exists, wait the hint + a 500ms buffer (`RETRY_BUFFER_MS`). When no hint, fall back to exponential backoff (`retryDelayMs * 2^retries`). Default `retryDelayMs = 10_000` because Bloomreach's observed penalty window is ~10s.
  → **Ceiling caps the wait.** `retryCeilingMs = 20_000` — even a server hint of 60s would cap at 20s. This bounds worst-case latency.

**Part 3 — why retry is in the DataSource, not the agent.**

The agent layer sees `dataSource.callTool` as a black box: either it returns a result, or it throws. The agent doesn't know about rate limits, doesn't know about retries, doesn't know `lastCallAt`. Hiding this complexity in the DataSource means:

  1. **Agents are testable in isolation.** The agent tests use a mocked DataSource that returns immediately; no need to simulate rate limits.
  2. **One place to evolve the retry logic.** Switch from parsed-window to true exponential backoff? One file change.
  3. **Cancellation works cleanly.** The `AbortSignal` threads through every sleep + every retry. A client navigating away interrupts mid-retry.

**Part 4 — backpressure (not explicitly implemented).**

Backpressure in the classical sense is "when the queue grows beyond a threshold, reject new requests." This codebase has no queue — agent loops are synchronous within a request, and each request gets its own session. The implicit backpressure is the request budget (300s `maxDuration` on `/api/briefing` and `/api/agent`):

  → If the rate-limit retry ladder eats too much wall-clock, the route hits 300s and Vercel terminates.
  → The per-phase log fires in `finally` so the timeout is observable.

This is "fail at the boundary, observable in logs" rather than queue-based backpressure. Acceptable for the current volume; would need a real queue if scaling to many concurrent users per session.

**Part 5 — Anthropic rate limits (not currently a concern).**

Anthropic has its own rate limits (tokens per minute, requests per minute per model). At this codebase's volume, the limits aren't pressing. The adapter at `lib/agents/aptkit-adapters.ts:42` doesn't have proactive spacing for Anthropic calls — if a future high-volume scenario lands, the same pattern (`liveCall` with spacing) would apply.

### Move 3 — the principle

**Be polite by default; recover gracefully when politeness fails.** Proactive spacing is the cheap defense (always pay 100ms-1100ms latency); retry is the expensive defense (only pays cost when the cheap defense failed). Layered together, the agent layer never sees a rate limit — the DataSource absorbs it.

## Primary diagram — the full recap

```
  Rate-limit defense in BloomreachDataSource

  agent.callTool(name, args)
       │
       ▼
  ┌─ Check cache (60s TTL) ─────────────────────────────────┐
  │  hit?  → return { result, durationMs:0, fromCache:true }│
  │  miss? → continue                                       │
  └──────────────────────┬──────────────────────────────────┘
                         │
                         ▼
  ┌─ Proactive spacing ─────────────────────────────────────┐
  │  elapsed = Date.now() - lastCallAt                       │
  │  if elapsed < 1100ms: sleep(1100 - elapsed)              │
  └──────────────────────┬──────────────────────────────────┘
                         │
                         ▼
  ┌─ Live call ─────────────────────────────────────────────┐
  │  transport.callTool(name, args, { signal })              │
  │  on error: throw McpToolError                            │
  │  on success: return result                               │
  └──────────────────────┬──────────────────────────────────┘
                         │
                         ▼
  ┌─ Retry ladder (when result is rate-limited) ────────────┐
  │  parse window from error text                            │
  │  wait = min(hint + 500ms, exponential backoff, 20s cap) │
  │  retry up to 3 times                                     │
  │  each retry waits, then loops to "Live call"             │
  └──────────────────────┬──────────────────────────────────┘
                         │
                         ▼
  ┌─ Cache write (success only) ────────────────────────────┐
  │  if !isError: cache.set(key, { result, expiresAt + 60s })│
  └──────────────────────┬──────────────────────────────────┘
                         │
                         ▼
  return { result, durationMs, fromCache: false }
```

## Elaborate

**Why the codebase doesn't use a global request queue.** Two reasons:

  1. **Per-session state.** The `lastCallAt` lives on the `BloomreachDataSource` instance, which is per-request. Two concurrent users have two separate spacing timers, both correctly enforcing 1.1s per-session. A global queue would centralize this but require shared state across instances.
  2. **Bloomreach rate-limits per USER, not per app.** Two users in different Bloomreach workspaces have independent rate limits server-side. Per-user spacing (which is what per-session gives us) is structurally right.

The cost: two users in the SAME workspace can each issue calls inside their own 1.1s window, totaling ~2 calls/sec across them. Bloomreach may 429 the second one. Retry handles it; the cost is wall-clock latency on the second user's calls.

**Why hint-from-error wins over exponential backoff.** When the server tells you exactly when to come back ("retry after 12 seconds"), waiting the stated window is more accurate than exponential backoff. The backoff is the fallback for when the server's error message doesn't carry a parseable hint. Two shapes are parsed; if neither matches, the codebase falls back to `retryDelayMs = 10_000` (the observed Bloomreach penalty window).

**The 20s ceiling math.** With `maxRetries = 3` and `retryCeilingMs = 20_000`, the worst-case single-call wall-clock is ~60s (3 retries × 20s each). For a 6-call monitoring scan, the worst case is bounded but real: 6 × 60s = 360s of retry wall-clock IF every call max-retries. Against a 300s route budget, this could fail. The actual observation is rare (the 60s cache absorbs repeats; the 1.1s spacing keeps most calls below the threshold). But it's a known edge case — surfaced via the per-phase log when it happens.

## Project exercises

### Exercise — Cross-session rate limiter using Vercel KV

  → **Exercise ID:** B6.4
  → **What to build:** Add a cross-session rate limiter that coordinates per-Bloomreach-workspace spacing across Vercel instances. Use Vercel KV to store `lastCallAt` per `workspace_id`. Before each live call, check KV; if another instance called <1.1s ago, sleep. Falls back to in-process spacing if KV is unreachable.
  → **Why it earns its place:** today, two concurrent users in the same Bloomreach workspace can each independently respect 1.1s spacing but together exceed it. The defense is retry, which costs wall-clock. Coordinating across instances eliminates the burst at the source.
  → **Files to touch:** `lib/data-source/bloomreach-data-source.ts` (extend `liveCall` to consult a shared store before the in-process timer), new `lib/state/rate-limiter.ts` (the Vercel KV wrapper), `test/data-source/rate-limiter.test.ts` (cover in-process fallback when KV is down).
  → **Done when:** simulated concurrent calls from two instances respect a shared 1.1s window, the in-process fallback path works when KV is unreachable, and the per-call telemetry surfaces whether the rate-limit check came from KV or local.
  → **Estimated effort:** 1–2 days.

## Interview defense

**Q: "How do you handle rate limits?"**

Three layered defenses inside `BloomreachDataSource`. First, a 60s response cache absorbs duplicates — most "calls" never reach the server. Second, proactive spacing — `~1.1s` between live calls, enforced via `lastCallAt` tracking. Third, parsed-window retry when a 429 slips through — read the server's stated penalty window from the error text (two shapes observed: `"Retry after ~12 second(s)"` and `"rate limit reached (1 per 10 second)"`), wait that long + a 500ms buffer, retry up to 3 times, every wait capped at 20s. Agents never see rate limits — they hit the DataSource, the DataSource handles it.

The latency cost: every retried call adds 10-20s, but the cache and proactive spacing keep retries rare.

*Anchor: "Cache + proactive spacing + parsed-window retry, all inside `BloomreachDataSource`. Three layers compose; agent never sees rate limits."*

**Q: "What's the edge case in your retry logic?"**

Worst case: 6 tool calls × 3 retries × 20s wait each = 360s of pure retry wall-clock. Against the 300s Vercel route budget, that route fails. In practice, the cache absorbs duplicates and the proactive spacing keeps most calls under threshold, so the worst case is rare — but it's known. The per-phase log fires in `finally` so when a route does hit 300s, the phase log shows which calls hit retries. Right move when this becomes a real problem is a circuit breaker (`B4.6`) — fast-fail when the server's clearly unhappy, instead of grinding through 3 retries × 20s.

*Anchor: "Bounded but real worst case (~6 minutes); circuit breaker is the next layer when it becomes a real problem."*

## See also

  → `01-llm-caching.md` — the 60s cache that absorbs most repeats
  → `05-retry-circuit-breaker.md` — the retry deep walk + the missing circuit breaker
  → `04-agents-and-tool-use/06-error-recovery.md` — adjacent: how the agent loop handles the post-retry result
  → `study-system-design/10-rate-limit-aware-mcp-client.md` — the same logic from the system-design lens

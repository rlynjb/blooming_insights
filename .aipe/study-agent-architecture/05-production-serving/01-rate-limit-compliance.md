# Rate-limit compliance

_Industry standard._

## Zoom out, then zoom in

Single-call retry handles one flaky request. An agent loop can hammer the same tool on every turn, and a fan-out topology multiplies that further. Blooming's version is a *spacing gate* (`minIntervalMs=1100`) that enforces the Bloomreach ~1 req/s ceiling regardless of how much the caller wants to fan out, plus a *retry ladder* with an explicit ceiling (`retryCeilingMs=20_000`) that respects Bloomreach's 10s penalty window.

```
  Zoom out — where the rate limiter sits

  ┌─ Agents (fan-out, ReAct loops, everything) ─────────────────┐
  │  can request tools as fast as they like                     │
  └───────────────────────────┬─────────────────────────────────┘
                              │ dataSource.callTool(name, args)
                              ▼
  ┌─ BloomreachDataSource ──────────────────────────────────────┐
  │  spacing gate: minIntervalMs=1100  ← ★ 1 REQ/S CEILING ★    │
  │  cache lookup / miss → live call                            │
  │  retry ladder on 429: retryDelayMs=10_000,                   │
  │                       retryCeilingMs=20_000                  │
  └───────────────────────────┬─────────────────────────────────┘
                              ▼
  ┌─ Bloomreach MCP server (alpha) ─────────────────────────────┐
```

Zoom in: this is the de-facto backpressure that shapes every fan-out in the system. Even if a caller fires 10 concurrent tool calls, the spacing gate serializes them to ~1/sec. That's the *effective* concurrency ceiling, regardless of what the caller thinks it configured.

## Structure pass

**Layers:** caller (agent, fan-out, load harness) · cache lookup · spacing gate (`minIntervalMs`) · retry ladder (429 → wait → retry) · retry ceiling.
**Axis:** *what enforces the ~1 req/s ceiling, and how does it compose with the caller's own concurrency cap?*
**Seam:** the `minIntervalMs=1100` sleep. Below it, the transport can fire freely; above it, calls are serialized on the wall clock.

```
  Rate control — two ceilings, sleep in the middle

  Caller: "please call these 5 tools"
                     │
                     ▼
  ┌─ minIntervalMs gate ──────────────────────┐
  │  if elapsed < 1100ms since lastCallAt:    │
  │     await sleep(1100 - elapsed)           │
  │  else: dispatch                            │
  └───────────────────────────────────────────┘
                     │
                     ▼ transport call
                     │
                     ▼ on 429:
  ┌─ retry ladder ─────────────────────────────┐
  │  waitMs = min(hintMs + BUFFER,             │
  │               retryDelayMs * 2^(retries-1),│
  │               retryCeilingMs)              │
  │  await sleep(waitMs); retry               │
  │  give up after maxRetries=3                │
  └───────────────────────────────────────────┘
```

## How it works

### Move 1 — the mental model

You've written a token bucket rate limiter before — allow N requests per window, sleep or reject when the bucket empties. `BloomreachDataSource`'s spacing gate is the degenerate one-slot version: allow one request per `minIntervalMs` window. Simpler, and fine when the ceiling is genuinely 1 req/s (Bloomreach's alpha server). The retry ladder is the second layer — when the spacing gate isn't enough (a burst still triggers a 429), the retry sleeps the *penalty window*, not the request window.

```
  Pattern: spacing gate + retry ladder

  ┌─ Every call ──────────────────────────────┐
  │  1. wait until minIntervalMs since last    │
  │  2. dispatch                              │
  │  3. if 429: parse retry-after, sleep,      │
  │             retry up to maxRetries=3       │
  │  4. give up → error propagates up          │
  └───────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**The spacing gate — `lib/data-source/bloomreach-data-source.ts:190-198`.** The load-bearing five lines:

```ts
// bloomreach-data-source.ts:190-198 — spacing gate
private async liveCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  // ... transport.callTool(...) ...
  this.lastCallAt = Date.now();
}
```

Line-by-line:

- **`this.lastCallAt`** — monotonic timestamp of the last dispatch. Instance-scoped, so one BloomreachDataSource instance = one spacing gate. If N callers share the same instance (which they do — one per request), N calls serialize through the same gate.
- **`elapsed < this.minIntervalMs`** — the check. Default `minIntervalMs=200` at construction, but agents typically get `1100` (safe above the ~1 req/s Bloomreach ceiling).
- **`await new Promise((r) => setTimeout(...))`** — the actual serialization. Awaiting here means the caller's `await callTool()` blocks. Multiple concurrent callers each hit this line and each sleeps its own delta — the last-caller-in waits the longest.
- **`this.lastCallAt = Date.now()`** — updated *after* the transport call, so slow calls don't compound. A 5-second query then a 1-second sleep = 6 seconds between requests. That's more conservative than resetting before the call, and it's the right call — Bloomreach counts *when the request lands*, not when the caller started waiting.

**The retry ladder — `lib/data-source/bloomreach-data-source.ts:158-174`.**

```ts
// bloomreach-data-source.ts:158-174 — retry on 429
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

Line-by-line:

- **`this.retryDelayMs ?? 10_000`.** The default fallback wait is Bloomreach's observed 10s penalty window. A shorter default (say 1s) would just burn retries inside the penalty window. Set at construction (`lib/data-source/bloomreach-data-source.ts:135`).
- **`this.retryCeilingMs ?? 20_000`.** The hard cap per wait. At `maxRetries=3` and this ceiling, a single call can burn up to ~60s of retries. That's already dangerous against the 60s route budget, so the ceiling stays low by default.
- **`parseRetryAfterMs`** — parses Bloomreach's error text for an explicit hint ("retry after 2000ms"). Honored when present, capped at ceiling.
- **`hintMs + RETRY_BUFFER_MS`** — adds a small buffer past the parsed hint to avoid landing exactly at the boundary. Real-world clocks drift.

**Why the spacing gate matters more than the caller's concurrency cap.** A fan-out with LOAD_CONCURRENCY=10 might expect 10x throughput. In practice the spacing gate serializes to ~1 req/s, so the *effective* concurrency is 1 for tool calls. Cranking LOAD_CONCURRENCY past what the spacing gate allows doesn't buy throughput — it buys queueing time, plus the risk of triggering retry ladders that compound the queueing further. See `02-fan-out-backpressure.md` for the load harness experiment.

**Cache-first, not retry-first.** Every callTool starts with a cache lookup (`lib/data-source/bloomreach-data-source.ts:144-152`). The cache TTL default is 60s. That means the spacing gate is only reached on cache misses — repeated queries within 60s return instantly and don't consume the ceiling. In practice this cuts the effective wire-call rate by ~40-60% depending on cache hit rate.

```
  Layers-and-hops — one tool call under load

  ┌─ agent.callTool('execute_analytics_eql', {...}) ────────────┐
  └───────────────────────────┬─────────────────────────────────┘
                              ▼
  ┌─ BloomreachDataSource.callTool ─────────────────────────────┐
  │  1. cache lookup (60s TTL)                                  │
  │     └─ HIT → return { fromCache: true, durationMs: 0 }      │
  │  2. MISS → liveCall:                                        │
  │     ├─ wait to satisfy minIntervalMs=1100                   │
  │     ├─ transport.callTool()                                 │
  │     └─ if 429: retry ladder                                 │
  │  3. write cache (non-error results only)                    │
  └───────────────────────────┬─────────────────────────────────┘
                              ▼
                        return result
```

### Move 3 — the principle

The rate limit ceiling *is* the effective concurrency ceiling. Callers that don't respect it get queueing plus 429s; callers that do get predictable throughput. The spacing gate is the enforcement primitive — one sleep per call, based on wall-clock since the last dispatch, no bucket accounting. The retry ladder handles the residual — when a burst somehow lands (or Bloomreach's window slides), the ladder sleeps the *penalty window*, not the *request window*. Getting these numbers right saves the whole system: a `retryDelayMs` shorter than the penalty window just burns retries inside the penalty; a `retryCeilingMs` higher than the route budget causes one bad call to eat the whole investigation.

## Primary diagram

```
  Recap — the rate-limit compliance surface

  Instance config (BloomreachDataSource):
  ┌──────────────────────────────────────────────────────┐
  │  minIntervalMs = 1100       ← spacing gate           │
  │  maxRetries = 3             ← retry budget           │
  │  retryDelayMs = 10_000      ← Bloomreach's 10s window│
  │  retryCeilingMs = 20_000    ← per-wait hard cap      │
  └──────────────────────────────────────────────────────┘

  Per call flow:
  cache lookup → HIT? return                (fast path)
              → MISS: wait(minIntervalMs)   (spacing)
                     → dispatch
                     → 429? retry ladder    (recovery)
                     → cache (non-error)
                     → return
```

## Elaborate

Bloomreach's alpha `loomi connect` server enforces ~1 req/s globally with a stated 10s penalty window on burst. Blooming's `minIntervalMs=1100` picks a value safely above that ceiling to avoid triggering the penalty in the first place; the retry ladder handles the residual burst that slips through (Bloomreach's window can slide, some tools cost more than others).

The `retryCeilingMs=20_000` cap is chosen against Vercel's 60s route budget: `maxRetries=3` at `~10s each can cost ~30s on a single call`, roughly half the route budget. Raising it risks blowing the per-investigation budget when a bad rate-limit run compounds across many calls. Lowering it risks giving up before Bloomreach's window opens. The current defaults are conservative but survivable.

The interaction with the eval load harness is the interesting bit: `LOAD_CONCURRENCY=3` sounds like triple throughput, but the spacing gate serializes tool calls to 1/sec anyway. What the concurrency cap actually parallelizes is the *Anthropic-side* work (each worker's ReAct loop against Sonnet), not the *Bloomreach-side* tool calls. Since Sonnet turns are ~5-8s and MCP calls are ~1-2s each, the effective bottleneck is the model side even under load. The receipt at `eval/load-receipts/load-2026-07-03T05-21-12-237Z.json` bears this out: at N=3, K=1 (sequential), total ran ~283s — roughly 90s per investigation, of which the model dominates.

Cross-reference: `study-ai-engineering`'s single-call rate-limit / retry-and-circuit-breaker mechanics cover the primitives. This file covers what those primitives look like once wrapped in a per-request instance that serves an autonomous loop.

## Interview defense

**Q: What enforces the effective concurrency ceiling on tool calls in this system?**
A: The `minIntervalMs=1100` spacing gate in `BloomreachDataSource.liveCall` at `lib/data-source/bloomreach-data-source.ts:190-198`. Every live call waits until at least 1100ms has passed since the last one. That serializes tool calls to ~1/sec regardless of how many callers request them concurrently. Even if the load harness runs LOAD_CONCURRENCY=10, tool calls still go through the gate one at a time. What the caller's concurrency cap actually parallelizes is the Anthropic-side model work; the Bloomreach side stays serialized. This is the load-bearing insight — the caller-side concurrency is for early bounding, but the transport-side gate is what the system actually runs at.

Diagram: the caller-cap and transport-gate as two ceilings the request must pass.
Anchor: `lib/data-source/bloomreach-data-source.ts:190-198` (spacing gate) + `lib/data-source/bloomreach-data-source.ts:135-137` (defaults).

**Q: Why is retryDelayMs 10 seconds, not 1?**
A: Bloomreach's rate-limit penalty window is ~10s ("1 per 10 second" in their error text). A shorter default (1s) just burns the attempt inside the same penalty window — the retry fails again, then again, until `maxRetries=3` is exhausted, with 3 seconds of wall-clock spent for zero effect. Setting the fallback base to the observed penalty window means the first retry lands *after* the window closes, which is when Bloomreach's limiter is willing to serve. The parsed `retry-after` hint is preferred when present; the 10s fallback covers the case where Bloomreach doesn't include one. The `retryCeilingMs=20_000` per-wait cap is set against Vercel's 60s route budget: at maxRetries=3, we can spend up to ~30s on retries per call, roughly half the route budget, which is the maximum we can afford without blowing the investigation.

Diagram: the 10s penalty window with retry attempts landing inside vs after.
Anchor: `lib/data-source/bloomreach-data-source.ts:132-137`.

## See also

- `02-fan-out-backpressure.md` — how the eval load harness runs against this ceiling.
- `03-fault-injection-and-graceful-degradation.md` — the fault injector mimics 429s to test the retry ladder.
- `04-cost-controls.md` — the ceiling also caps per-investigation time, which caps cost.
- `04-agent-infrastructure/03-tool-calling-and-mcp.md` — the DataSource port that wraps this rate limiter.
- Cross-reference: `.aipe/study-ai-engineering/`'s single-call rate-limit + retry-and-circuit-breaker file.

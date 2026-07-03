# rate-limit spacing and retry ladder

**Industry name(s):** rate-limit compliance · client-side throttling · token-bucket spacing · retry ladder with parsed retry-after. **Type label:** Industry standard.

## Zoom out — where the gate sits

The gate is the seam between the agent's tool call and the Bloomreach MCP transport. Every call waits until enough time has passed since the last one, then dispatches; every 429 result triggers a retry after the server's stated window.

```
Zoom out — where the spacing gate sits

┌─ Service band (agent) ──────────────────────────────────┐
│  agent ReAct loop → dataSource.callTool(name, args)      │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─ Data-source band (adapter) ─────────────────────────────┐
│  BloomreachDataSource                                    │
│   ★ liveCall(): if elapsed < 1100ms, sleep and space ★    │ ← the spacing gate
│   ★ rate-limit? retry after parsed window ★               │ ← the retry ladder
└─────────────────────────┬───────────────────────────────┘
                          │
┌─ Transport band ─────────▼──────────────────────────────┐
│  SdkTransport (AbortSignal.timeout 30s per call)         │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─ Provider band ──────────▼──────────────────────────────┐
│  Bloomreach loomi connect MCP server                     │
│  enforces "1 per 10 second" per-user global limit        │
└──────────────────────────────────────────────────────────┘
```

**Zoom in — what it is.** Two coupled mechanisms. The **spacing gate** (`minIntervalMs = 1100`) is a proactive wait: if less than 1.1 seconds have passed since the last call, sleep the difference. The **retry ladder** (`retryDelayMs = 10_000`, `retryCeilingMs = 20_000`, `maxRetries = 3`) is reactive: if the server returns a rate-limit error, parse its stated window and retry after it.

**The load-bearing distinction.** This is **rate-limit compliance, not backpressure.** No queue exists. No consumer is being protected from an overload. There's a server that publishes a quota and a client that stays under it. If you called this backpressure in an interview, a listener familiar with the term would immediately ask "what's the queue and what's the shedding policy?" — and there are none.

## Structure pass — layers · one axis · one seam

The axis worth tracing is **who's controlling the pace**.

```
one axis held: "who's setting the pace right now?"

┌─ agent ReAct loop ────────────────────────────────┐
│  wants: call as fast as possible                   │  → agent is EAGER
└──────────────────────┬─────────────────────────────┘
                       │  seam: dataSource.callTool
┌─ BloomreachDataSource ▼──────────────────────────┐
│  liveCall gates:                                   │  → adapter is COMPLIANT
│   · proactive: if elapsed < 1100ms, sleep          │
│   · reactive: on 429, parse window, retry          │
└──────────────────────┬─────────────────────────────┘
                       │  seam: HTTP over MCP transport
┌─ Bloomreach server ──▼────────────────────────────┐
│  states quota: 1 per 10 second (per user global)   │  → server SETS THE PACE
│  429 with "retry after ~10 second"                 │
└────────────────────────────────────────────────────┘
```

**The seam.** The adapter is the compliant middle. It knows the agent is eager and the server is strict, and it inserts the pace-setting logic between them. Take the adapter out and either the agent burns every call in a 429 cascade or the server bans the key. The adapter is a *conformance layer*.

## How it works

### Move 1 — the mental model

You've probably rate-limited a `fetch` in a for-loop by doing `await new Promise(r => setTimeout(r, 500))` between calls. That's the primitive. Scale it up: (1) measure the actual elapsed time between calls, don't wait a fixed 500ms — if the last call took 800ms, only wait 300ms more; (2) when the server *does* say "too fast," honor its stated recovery window instead of guessing.

```
The pattern — proactive gate + reactive retry

┌────────────────────────────────────────────────────┐
│                                                    │
│  callTool(name, args)                              │
│    │                                               │
│    ▼                                               │
│  ┌─ PROACTIVE GATE ──────────────────────────┐    │
│  │  elapsed = now - lastCallAt                │    │
│  │  if (elapsed < 1100ms) sleep the diff      │    │
│  │  → dispatch                                 │    │
│  └──────────────┬────────────────────────────┘    │
│                 │                                  │
│                 ▼                                  │
│         Bloomreach responds                        │
│                 │                                  │
│                 ▼                                  │
│  ┌─ REACTIVE LADDER ─────────────────────────┐    │
│  │  is 429? parseRetryAfterMs(err)             │    │
│  │  wait = min(hint + 500, retryCeilingMs)     │    │
│  │  else exponential backoff off retryDelayMs  │    │
│  │  retry (up to maxRetries = 3)               │    │
│  └────────────────────────────────────────────┘    │
│                                                    │
└────────────────────────────────────────────────────┘
```

Both mechanisms are necessary. Without the gate, you'd 429 on nearly every call (the server publishes 1 per second AND 1 per 10 second windows in different modes). Without the ladder, the moment you cross into the 10-second penalty window, all three retries fire fast and burn.

### Move 2 — the step-by-step walkthrough

#### Step 1 — set the proactive gate at connection time

`lib/mcp/connect.ts:96`:

```typescript
return {
  ok: true,
  mcp: new BloomreachDataSource(new SdkTransport(client, httpErrors), {
    minIntervalMs: 1100,
    retryDelayMs: 10_000,
    retryCeilingMs: 20_000,
    maxRetries: 3,
  }),
};
```

The comment right above at line 86 is where the design lives:

> "Bloomreach rate-limits per user GLOBALLY and states the window in the error text — observed as both `(1 per 1 second)` and `(1 per 10 second)`. Proactive spacing stays at ~1.1s on purpose: spacing at the full 10s window would cost ~60s for a 6-call investigation and blow the route's 60s budget (app/api/agent). Instead, BloomreachDataSource parses the stated window from each 429 and waits it out on retry."

**The pick.** 1.1s spacing meets the tighter observed window. If the server is in "1 per 10 second" mode, this gate WILL trigger 429s — which is fine because the reactive ladder handles them. Spacing at 10s proactively would be safer but blow the route's 300s budget.

**What breaks if `minIntervalMs = 0`:** every call is dispatched immediately. First few succeed; the fifth or sixth hits the "1 per 1 second" limit, 429s, and the ladder kicks in. Depending on the window mode, you can spend the whole 300s route budget cycling through retry-then-429-then-retry with nothing to show.

#### Step 2 — the gate itself is a subtraction, not a fixed sleep

`lib/data-source/bloomreach-data-source.ts:190`:

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

Note the *subtraction* pattern: `sleep(minIntervalMs - elapsed)`. If the previous call took 800ms of network time, this only waits 300ms more. A naive `sleep(minIntervalMs)` after each call would add 1.1s regardless — a 100% overhead when the network is slow.

**Also note `lastCallAt = Date.now()` in BOTH the success and error path.** This is subtle: if the last call errored, you still don't want to hammer the server on the retry. Setting `lastCallAt` in the catch keeps the gate honest even on failure.

**What breaks if you only set `lastCallAt` on success:** after an error you dispatch the retry immediately, defeating the gate. The Bloomreach server sees two calls in a burst and 429s the retry too.

#### Step 3 — parse the server's stated retry window

`lib/data-source/bloomreach-data-source.ts:64`:

```typescript
function parseRetryAfterMs(result: unknown): number | null {
  const text = JSON.stringify((result as any)?.content ?? result);
  const after = text.match(/retry[\s-]*after[^0-9]*(\d+)\s*second/i);
  if (after) return parseInt(after[1], 10) * 1000;
  const perWindow = text.match(/per\s*(\d+)\s*second/i);
  if (perWindow) return parseInt(perWindow[1], 10) * 1000;
  return null;
}
```

Two observed shapes in the error text:
- `"Retry after ~12 second(s)"` → 12 seconds
- `"rate limit reached (1 per 10 second)"` → 10 seconds (the penalty window)

Returns `null` when nothing parseable is present — caller falls back to exponential backoff.

**What breaks if regex fails silently:** you fall through to the exponential backoff path (`retryDelayMs * 2^(retries-1)`). Default `retryDelayMs = 10_000` matches the observed window, so this is a fine fallback. If the server ever changes its error format and neither regex hits, the fallback still lands in the right ballpark.

#### Step 4 — the retry ladder

`lib/data-source/bloomreach-data-source.ts:163`:

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

Three things worth naming:

1. **`RETRY_BUFFER_MS = 500`** at line 49 — a small cushion on top of the server-stated window so the retry lands just *after* the penalty clears rather than on its boundary. Without it, the retry can be inside the same window.
2. **`retryCeilingMs = 20_000`** — upper bound on any single wait. Design note at line 158 in `bloomreach-data-source.ts`: "Latency note: against the 60s route budget (app/api/agent), maxRetries=3 at ~10s each can cost ~30s on a *single* call, so the cap stays low by default — raising it risks blowing the per-investigation budget." (The budget is 300s now, but the math still holds — you don't want one call spending 60s on retries.)
3. **Only 429s retry.** `isRateLimited(result)` at line 51 checks for `isError: true` with rate-limit text in the payload. Timeouts (which throw `HTTP 0: timeout after 30000ms`) never reach this loop — they're wrapped in `McpToolError` and propagate. That's on purpose. A timeout retry would just risk another 30s wait.

```
Layers-and-hops — one call through both gates

┌─ Agent turn ─────────────┐  hop 1: dataSource.callTool
│  execute_analytics_eql   │ ──────────────────────────────┐
└──────────────────────────┘                               │
                                                            ▼
                                        ┌─ BloomreachDataSource ┐
                                        │  ★ PROACTIVE GATE ★    │
                                        │  elapsed check         │
                                        │  if < 1100ms → sleep   │
                                        └────────┬───────────────┘
                                                 │  hop 2: transport.callTool
                                                 ▼
                                        ┌─ SdkTransport ────────┐
                                        │  AbortSignal.timeout   │
                                        │  30_000 per-call cap   │
                                        └────────┬───────────────┘
                                                 │  hop 3: HTTP to Bloomreach
                                                 ▼
                                        ┌─ Bloomreach MCP server │
                                        │  returns 429 with      │
                                        │  "retry after 10 sec"  │
                                        └────────┬───────────────┘
                                                 │  hop 4: back up
                                                 ▼
                                        ┌─ BloomreachDataSource ┐
                                        │  ★ REACTIVE LADDER ★   │
                                        │  parse window → 10s    │
                                        │  sleep 10.5s           │
                                        │  retry (up to 3×)      │
                                        └────────┬───────────────┘
                                                 │  hop 5: success or exhausted
                                                 ▼
                                        ┌─ back to agent ────────┐
                                        │  { result, durationMs, │
                                        │    fromCache: false }  │
                                        └────────────────────────┘
```

#### Step 5 — errors aren't cached

`lib/data-source/bloomreach-data-source.ts:179`:

```typescript
// Don't cache error results — they should not poison the cache.
if ((result as any)?.isError === true) {
  return { result: result as T, durationMs, fromCache: false };
}
```

After the retry ladder exhausts, if the final result is still an error, it's returned but not cached. Otherwise the next call for the same args would hit the poisoned cache entry and see the error repeatedly.

**What breaks if you cache errors:** the 60s TTL now caches the failure, and every ReAct-loop retry-with-same-args returns the same stale error. The model reasons around the fake error, tries something different, and the agent lands sideways.

### Move 3 — the principle

Rate-limit compliance and backpressure are different problems. **Compliance** stays under a published quota — the pace-setter is external. **Backpressure** protects a slow consumer — the pace-setter is internal. This repo does compliance only. The mechanism is a subtraction-based proactive gate + a parsed-window reactive ladder, and both exist because a single mechanism can't cover both the tight window ("1 per 1s") and the wide window ("1 per 10s") the server switches between.

The teaching point beyond this repo: the moment you find yourself sleeping between API calls in a for-loop, you're already partway to this pattern. Name it — proactive gate + reactive ladder — and the tunables (the interval, the ceiling, the retries) become explicit knobs instead of magic numbers.

## Primary diagram — the recap

```
The rate-limit-compliance pattern — end to end

┌─ Config (at connect time) ─────────────────────────────────────┐
│  minIntervalMs:  1100     (proactive spacing gate)              │
│  retryDelayMs:   10_000   (fallback backoff base)               │
│  retryCeilingMs: 20_000   (single-wait cap)                     │
│  maxRetries:     3                                              │
│  RETRY_BUFFER_MS: 500     (cushion on parsed window)            │
└──────────────────────────────┬─────────────────────────────────┘
                               │
                               ▼
┌─ callTool(name, args) ─────────────────────────────────────────┐
│                                                                 │
│  cache check → hit? return { fromCache: true }                  │
│                                                                 │
│  liveCall:                                                      │
│    elapsed = now - lastCallAt                                   │
│    if elapsed < 1100 → sleep(1100 - elapsed)  ← PROACTIVE GATE  │
│    dispatch via transport                                       │
│    lastCallAt = now  (in BOTH success + catch)                  │
│                                                                 │
│  while (isRateLimited(result) && retries < 3):  ← RETRY LADDER  │
│    hint = parseRetryAfterMs(result)                             │
│    wait = min(hint + 500, 20_000) or backoff × 2^n              │
│    sleep(wait)                                                  │
│    result = liveCall(...)                                       │
│                                                                 │
│  if isError → return without caching                            │
│  else cache with 60s TTL                                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Elaborate

The proactive gate is a subtraction-based token bucket without the bucket — just one token, one slot. That's fine at low request rates. A real token bucket becomes worth it when you want burst capacity plus a sustained rate; here Bloomreach doesn't publish burst capacity, so the single-token model is honest.

Parsing the server's stated retry window comes from the HTTP spec: 429 responses can carry a `Retry-After` header. Bloomreach's MCP server puts it in the error message body instead — same idea, different transport. This pattern of "extract the wait from the error" is universal and worth naming; if you've done this against a Stripe 429 or a GitHub 403, you've built the same thing.

**Adjacent primitive worth naming.** This is exactly the shape of TCP's congestion control at a much coarser grain: send at some rate, watch for loss (429), back off, gradually recover. The difference is TCP does the recovery for you; here you're implementing it in userspace against an application protocol.

**What to read next.** `06-response-cache-and-demo-replay.md` for how the 60s cache absorbs repeats (the memoization that reduces how often the gate fires at all). `04-load-harness-with-fault-injection.md` for the fake-fault version of the same 429 shape.

## Interview defense

**Q: Walk me through the rate-limit story. Why 1.1 seconds when the observed window is 10 seconds?**

The load-bearing point is: this is **rate-limit compliance, not backpressure.** There's no queue, no shedding, no slow consumer being protected — just a server that publishes a quota and a client staying under it. The Bloomreach alpha server publishes two windows in different modes: 1 per 1 second, and 1 per 10 second. Proactive spacing at 10 seconds would blow the 300s route budget on a 6-call investigation. So I space at 1.1 seconds — which meets the tight window, and when the server's in the wide window it 429s and the reactive ladder handles it. The ladder parses the stated retry window out of the error text (`"retry after ~10 seconds"` or `"per 10 second"`) and honors it plus a 500ms buffer. If nothing parses, it falls back to exponential backoff from a 10-second base, capped at 20 seconds per single wait, max 3 retries. Only 429s retry — timeouts fail fast because a retry would just cost another 30-second wall-clock wait against the route budget.

```
The anchor diagram to sketch

      proactive gate                 reactive ladder
┌─────────────────────┐          ┌───────────────────────┐
│ elapsed = now - lca │          │ isRateLimited?         │
│ if < 1100 → sleep   │          │ parse retry-after      │
│ dispatch            │          │ min(hint+500, 20s)     │
│ lca = now (always)  │          │ retry (up to 3)        │
└─────────────────────┘          └───────────────────────┘
        proactive                       reactive
      client sets pace          server sets pace on failure
```

**Q: What's the difference between rate-limit compliance and backpressure?**

Backpressure protects a slow consumer — think of a Kafka consumer that can't keep up, so the producer slows down or the queue fills, or messages get shed. The pace-setter is the *consumer*. Rate-limit compliance stays under a published quota — the pace-setter is *external*. Different problems, different mechanisms. This codebase does compliance only. If I called what's here backpressure in an interview, a listener familiar with the term would immediately ask "what's the queue, what's the shedding policy?" and there aren't any.

**Q: Why set `lastCallAt` in the catch block too?**

Subtle bug guard. If you only set it on success, an error path leaves `lastCallAt` unchanged, so the next dispatch computes the gate against a stale timestamp and fires immediately. The server sees two calls back-to-back and 429s the retry too. Setting `lastCallAt` in both paths keeps the gate honest.

**Q: Why is the retry ladder ceiling only 20 seconds?**

Against the 300s route budget, 3 retries × 20s cap = 60s max per single call. That leaves 240s for the rest of the investigation. If I raised the ceiling to 60s per retry, one 429-heavy call could burn the whole route. The current cap is small on purpose — a call that can't recover in 60s of retries should fail and let the model try a different query.

**Q: Where would backpressure show up if you added it?**

If I added a work queue between the route handler and the agent — say, to survive a burst of concurrent investigation requests — that's where. Queue depth becomes a signal; when it crosses a threshold, either reject new requests (load shed) or slow down the producers (real backpressure). Today the route runs each investigation synchronously inside the request, so there's no queue and no place for backpressure to attach. Named for what it isn't, not a fix I'd make speculatively.

## See also

- `06-response-cache-and-demo-replay.md` — the 60s cache is the other half of the story; it reduces how often the gate fires.
- `04-load-harness-with-fault-injection.md` — injected 429s exercise the same ladder against the synthetic path.
- `audit.md` §5 — io-network-and-database-bottlenecks lens finding.
- `audit.md` §6 — caching-batching-and-backpressure lens finding (the distinction).

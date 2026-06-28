# 02 — MCP spacing and retry

Proactive rate-limit compliance + server-stated retry hint · Language-agnostic pattern · Project-specific tuning

## Zoom out — where this pattern lives

Every tool call from an agent goes through the adapter layer before it touches the network. The adapter is where rate-limit compliance lives — it spaces calls just inside the upstream's penalty window, and on the rare 429 it parses the server's stated wait time and honors it.

```
  Zoom out — where spacing + retry sit

  ┌─ Agent layer ───────────────────────────────────────────────┐
  │  DiagnosticAgent → AptKit loop → callTool(name, args)        │
  └────────────────────────────┬────────────────────────────────┘
                               │
  ┌─ DataSource adapter ───────▼────────────────────────────────┐
  │  BloomreachDataSource.callTool                               │
  │  ★ spacing + retry live HERE ★ ← we are here                 │
  │  (cache → spacing → live call → on-429 retry)                │
  └────────────────────────────┬────────────────────────────────┘
                               │
  ┌─ MCP transport ────────────▼────────────────────────────────┐
  │  StreamableHTTPClientTransport (MCP SDK)                     │
  └────────────────────────────┬────────────────────────────────┘
                               │
  ┌─ Bloomreach MCP (alpha) ───▼────────────────────────────────┐
  │  rate limit: ~1 per 1s observed, ~1 per 10s when squeezed    │
  └─────────────────────────────────────────────────────────────┘
```

**The teaching point — and the most common misread.** This is NOT backpressure. Backpressure means a downstream-pressure signal slowing an upstream producer ("the queue is full, slow down"). Here, the agent issues calls one at a time and the adapter just sleeps before each one regardless of downstream state. That is **rate-limit compliance** — also called proactive spacing, request shaping, or pacing. Calling it backpressure on stage will get you caught.

## Structure pass — layers, axis, seams

**Layers:**
- Agent — issues `callTool(name, args)` whenever the model emits a `tool_use` block
- Adapter — caches, paces, retries
- Transport — single MCP request, bounded by 30s per-call timeout
- Server — rate-limited; returns a 429 envelope with the window stated in text

**The axis: who controls call timing?**

```
  Tracing "who controls when the next call goes out?" down the stack

  ┌─ Agent ─────────────────────────────────────────┐
  │  "the model wants to call X NOW"                 │   the AGENT decides
  └─────────────────────────────────────────────────┘    when to ASK
       ┌─────────────────────────────────────────────┐
       │ Adapter                                      │
       │  "wait until elapsed >= minIntervalMs"       │  the ADAPTER decides
       │  "if 429, wait the server's stated window"   │  when to SEND
       └─────────────────────────────────────────────┘
            ┌────────────────────────────────────────┐
            │ Transport                               │   the TRANSPORT
            │  fires immediately when adapter calls   │   has no opinion
            └────────────────────────────────────────┘
                 ┌──────────────────────────────────┐
                 │ Server                            │  the SERVER decides
                 │  accepts OR returns 429 + window  │  whether to ANSWER
                 └──────────────────────────────────┘
```

The seam between **agent** and **adapter** is the load-bearing one. On the agent side: "I want to call this tool right now." On the adapter side: "I will, but not until 1.1s after the last call." The contract is `callTool(name, args) → Promise<{ result, durationMs, fromCache }>`. The agent never sees the spacing or the retry; it just sees a slightly slower-resolving promise.

## How it works

### Move 1 — the mental model

You know how a debounce works in a form input: keystroke arrives, you don't fire the search yet, you set a timer; another keystroke resets the timer; eventually the timer expires and you fire one search. Spacing is the cousin shape, with one difference: you fire **every** call, you just delay each one until the floor under the previous call has cleared.

```
  Spacing — the kernel

           caller wants:    │ A │ B │ C │ D │
                            │   │   │   │   │
           spacing inserts: │ A │ . │ B │ . │ C │ . │ D │
                            └─0─┴1.1┴───┴1.1┴───┴1.1┴───┘
                              ms  s        s        s
           lastCallAt updated after each call returns
```

The retry ladder is the second mechanism that lives in the same call path. When the server says "no, you tried too soon," parse its stated window and wait it out.

```
  Retry — the kernel

  call(name, args)
     │
     ▼
  was the result a 429-shaped error?
     │ no  → return  (DONE)
     │ yes →
     ▼
  parse the server's text: "retry after X" or "per X second"
     │
     ▼
  wait = min(parsed_hint + buffer  OR  retryDelayMs × 2^(retries-1),
             retryCeilingMs)
     │
     ▼
  retry the call (up to maxRetries = 3)
```

The two mechanisms are stacked: spacing is for the **expected** rate; retry is for **when the expected rate is wrong** (a different user just burned the global quota, the window tightened, etc.).

### Move 2 — step by step

**The spacing floor — `minIntervalMs`**

This is the floor under every call. Set at construction time in `connectMcp`:

```ts
// lib/mcp/connect.ts:86-102
// Bloomreach rate-limits per user GLOBALLY and states the window in the
// error text — observed as both "(1 per 1 second)" and "(1 per 10 second)".
// Proactive spacing stays at ~1.1s on purpose: spacing at the full 10s
// window would cost ~60s for a 6-call investigation and blow the route's
// 60s budget (app/api/agent). Instead, BloomreachDataSource parses the stated
// window from each 429 and waits it out on retry (see retryDelayMs/retryCeilingMs),
// and the 60s response cache absorbs repeats. retryDelayMs falls back to the
// observed 10s window when no hint is parseable.
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

The number `1100` is a **deliberate compromise**, not a "1s, plus a bit." Spacing at the FULL 10s window would cost ~60s for a 6-call investigation (6 × 10s) and would blow the route budget by itself. So spacing is set just inside the observed 1s window; when the server tightens to 10s, the retry ladder absorbs it. The comment in `connect.ts` is the documentation of this tradeoff.

**The sleep — inside `liveCall`**

The actual mechanism is four lines:

```ts
// lib/data-source/bloomreach-data-source.ts:190-205
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

Pseudocode of what this does:

```
  function liveCall(name, args, signal):
    elapsed = now - lastCallAt
    if elapsed < minIntervalMs:                // gate the call
      sleep(minIntervalMs - elapsed)
    result = await transport.callTool(name, args, signal)
    lastCallAt = now                            // start the next floor
    return result
```

Execution trace — three back-to-back calls:

```
  t = 0       call A → elapsed=∞ → no sleep → A fires → returns at t=300ms
                       lastCallAt = 300

  t = 350ms   call B → elapsed=50ms → sleep(1050ms) → B fires at t=1400ms
                       returns at t=1700ms → lastCallAt = 1700

  t = 1750ms  call C → elapsed=50ms → sleep(1050ms) → C fires at t=2800ms
                       returns at t=3100ms → lastCallAt = 3100
```

Notice: `lastCallAt` is set AFTER the call returns (or throws), not before. That means the spacing measures from "last response received" not "last request sent." If a call took 5s, the next call fires immediately — the inflight time counts as part of the spacing.

**The 429 detector — `isRateLimited`**

The server states the rate-limit error inside the tool-result envelope (not as an HTTP 429 — Bloomreach returns 200 with `isError: true`). The detector reads the envelope:

```ts
// lib/data-source/bloomreach-data-source.ts:51-55
function isRateLimited(result: unknown): boolean {
  if (!result || typeof result !== 'object' || (result as any).isError !== true) return false;
  const text = JSON.stringify((result as any).content ?? result);
  return /rate limit|too many requests/i.test(text);
}
```

This is the seam between "real error" and "rate-limit error." Real errors return immediately to the caller (they get cached as transient — except no, they don't get cached, see `03-ttl-cache-no-cache-on-error.md`). Rate-limit errors trigger the retry ladder.

**The retry hint parser — `parseRetryAfterMs`**

When the server says "rate limit," it often states the window. The parser pulls a wait hint out of two observed shapes:

```ts
// lib/data-source/bloomreach-data-source.ts:57-71
/**
 * Pull a wait hint (ms) out of a Bloomreach rate-limit error envelope. Two
 * shapes are observed in the wild:
 *   "Retry after ~12 second(s)"            → 12_000
 *   "rate limit reached (1 per 10 second)" → 10_000  (the penalty window)
 * Returns null when nothing parseable is present (caller falls back to backoff).
 */
function parseRetryAfterMs(result: unknown): number | null {
  const text = JSON.stringify((result as any)?.content ?? result);
  const after = text.match(/retry[\s-]*after[^0-9]*(\d+)\s*second/i);
  if (after) return parseInt(after[1], 10) * 1000;
  const perWindow = text.match(/per\s*(\d+)\s*second/i);
  if (perWindow) return parseInt(perWindow[1], 10) * 1000;
  return null;
}
```

The buffer (`RETRY_BUFFER_MS = 500`, line 49) is added on top of the parsed hint so the retry lands JUST AFTER the penalty clears, not on its boundary. Boundary retries are a known mode that re-trip the limit.

**The retry ladder — inside `callTool`**

The full mechanism in one read:

```ts
// lib/data-source/bloomreach-data-source.ts:163-174
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

Pseudocode of the decision:

```
  while result is rate-limited AND retries < maxRetries:
    retries += 1
    hint = parse_retry_window_from_error_text(result)
    fallback = retryDelayMs × 2^(retries-1)          // exponential backoff
    wait = min(
      hint != null ? hint + 500ms : fallback,
      retryCeilingMs                                  // every wait capped
    )
    sleep(wait)
    result = liveCall(name, args, signal)             // RE-FIRES through spacing
```

Execution trace — a call hits a 429, server says "per 10 second":

```
  t = 0       liveCall fires → spacing waits 800ms → call fires at t=800ms
              returns at t=900ms with { isError: true, content: "...per 10 second..." }

  isRateLimited(result) → true
  retries = 1, hintMs = 10_000, backoffMs = 10_000 × 2^0 = 10_000
  waitMs = min(10_000 + 500, 20_000) = 10_500

  t = 900ms   sleep(10_500ms)
  t = 11_400ms liveCall fires AGAIN → spacing already cleared → fires immediately
               returns at t=11_700ms → SUCCESS
```

Total elapsed: ~11.7s for one tool call. That is why `retryCeilingMs: 20_000` matters — without the cap, an unparseable error would fall back to exponential backoff (`10s, 20s, 40s, ...`) and a single call could chew >60s of the 300s budget.

**The interplay with the route budget**

This whole mechanism nests inside the 300s route budget (`01-vercel-route-budget.md`). Worst-case single call: `maxRetries=3 × retryCeilingMs=20s = 60s` of waiting + the actual call. With `maxToolCalls=6` per agent, a worst-case investigation could theoretically spend 6 × ~21s = ~126s on a single agent's calls — still inside 300s, but uncomfortably close.

The comment at `lib/data-source/bloomreach-data-source.ts:161-162` calls this out:

> Latency note: against the 60s route budget (app/api/agent), maxRetries=3 at ~10s each can cost ~30s on a *single* call, so the cap stays low by default — raising it risks blowing the per-investigation budget.

(The comment mentions a 60s route budget because it predates the 300s bump; the principle is unchanged.)

### Move 3 — the principle

When you talk to an upstream that has its own rate limit, the right shape is: **pace at the expected limit, retry against the stated limit, cap every wait so a misbehaving upstream cannot blow your budget.** The pacing handles the steady state; the retry handles the transient; the cap protects against the unknown.

The thing this is NOT: backpressure. Backpressure is a closed-loop signal — downstream tells upstream "I'm full" and upstream slows. This is open-loop — upstream just sleeps before every send. The distinction matters because it tells you what to do when the limit changes: backpressure adapts automatically; rate-limit-compliance requires you to update the constant. Bloomreach tightening from 1/s to 1/10s is the exact case where this code's design choice (low spacing + parse-the-window retry) wins over a "set spacing to 10s and call it backpressure" approach.

## Primary diagram

The full pattern in one frame.

```
  Spacing + retry — one call's complete lifecycle

  ┌─ Adapter: BloomreachDataSource.callTool ─────────────────────────────────┐
  │                                                                            │
  │  1. cache check                                                            │
  │     cached && cached.expiresAt > Date.now()?                               │
  │     yes → return { result, durationMs: 0, fromCache: true } (DONE)        │
  │                                                                            │
  │  2. liveCall (loop entry)                                                  │
  │     elapsed = now - lastCallAt                                             │
  │     if elapsed < minIntervalMs:                                            │
  │       sleep(minIntervalMs - elapsed)        ← SPACING                     │
  │     result = await transport.callTool(name, args, {signal})                │
  │     lastCallAt = now                                                       │
  │                                                                            │
  │  3. retry decision                                                         │
  │     while isRateLimited(result) && retries < 3:                            │
  │       hint = parseRetryAfterMs(result)                                     │
  │       wait = min(hint+500 ?? retryDelayMs*2^retries, retryCeilingMs)      │
  │       sleep(wait)                            ← RETRY LADDER                │
  │       retries++                                                            │
  │       result = liveCall(name, args, signal) ← RE-ENTERS SPACING            │
  │                                                                            │
  │  4. cache decision                                                         │
  │     if result.isError → return without writing cache                       │
  │     else → cache.set(key, { result, expiresAt: now + ttl })                │
  │            (see 03-ttl-cache-no-cache-on-error.md)                         │
  │                                                                            │
  │  5. return { result, durationMs, fromCache: false }                        │
  └──────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where this pattern comes from.** Open-loop rate-limit compliance is one of the oldest tricks in distributed-systems engineering — the cron job that "runs at most once per minute" by sleeping if it ran less than 60s ago is the same shape. The token-bucket and leaky-bucket algorithms (from network QoS literature) are the more general forms: spacing is the simplest leaky bucket with a single token.

**Why parse the server's text instead of using HTTP 429.** Bloomreach's MCP server returns rate-limit errors INSIDE the tool envelope (`isError: true` + text content), not as an HTTP 429 with a `Retry-After` header. Parsing the text is the only signal available. If they migrated to standard HTTP 429 + `Retry-After`, the parser would simplify to reading one header — but the structural shape (parse the server's stated window, fall back to backoff, cap the wait) would be unchanged.

**The synthetic-data escape hatch.** `live-synthetic` mode (`lib/data-source/synthetic-data-source.ts`) bypasses this entire mechanism. `SyntheticDataSource.callTool` does NO spacing, NO retry, NO cache — it just dispatches and returns. The real agent loop sees identical latency characteristics on the model side; the network side collapses to in-process time. This is the lever to reach for when the alpha MCP server is misbehaving and you cannot afford another reset before the demo.

**Adjacent guides.**
- `study-runtime-systems` covers `AbortSignal` composition (used to cancel an in-flight retry when the user closes the tab).
- `study-system-design` covers the MCP transport layer in more depth (OAuth, DCR, the streamable-HTTP shape).
- `01-vercel-route-budget.md` is the outer ceiling these waits eat into.

## Interview defense

> **"Is the 1.1s spacing backpressure?"**

```
  Backpressure vs rate-limit compliance — different mechanisms

         BACKPRESSURE                       RATE-LIMIT COMPLIANCE
  (what people MISREAD this as)             (what this actually is)

   downstream sends signal               upstream just sleeps before
   upstream slows accordingly            every send — no signal needed
   ──────────────────────                ──────────────────────────────
   "the queue is full"                   "I know your limit, I pre-pace"
   "the consumer fell behind"            "I'll wait 1.1s regardless"
   closed-loop, adaptive                 open-loop, fixed constant
```

No. Backpressure is a downstream-pressure SIGNAL slowing an upstream producer — a closed-loop adaptation. This is open-loop: I sleep 1.1s before every call regardless of what the server is doing. It's rate-limit compliance — also called proactive spacing or pacing. The reason the distinction matters: when Bloomreach tightened from 1/s to 1/10s, this code didn't adapt automatically; it relied on the retry ladder parsing the new window and waiting it out. A true backpressure system would have slowed the upstream agent loop based on downstream pressure. We don't do that. Anchor: `lib/data-source/bloomreach-data-source.ts:190-205`.

> **"What's the load-bearing part most people forget when they add a retry ladder?"**

The cap on a single wait — `retryCeilingMs`. Without it, exponential backoff can grow unbounded: `10s, 20s, 40s, 80s, ...` and one call eats your whole route budget. We cap each wait at 20s and limit total retries to 3. Worst case on a single call is ~60s of waiting plus the call itself. The cap is the difference between "retry storms eat the request budget" and "retries bound their own cost." Anchor: `lib/data-source/bloomreach-data-source.ts:163-174`, look at the `Math.min(..., retryCeilingMs)` line.

> **"Why is `lastCallAt` updated AFTER the call returns, not before?"**

Two reasons. First, if the call takes 5s, the network already did the spacing for me — firing another call immediately is fine because the server saw nothing for those 5s. Second, on a thrown error I still update `lastCallAt` (see the `catch` block at line 199-201), so a failed call doesn't let the next one race straight through. The variable measures "time since last response received," not "time since last request sent." That choice keeps the floor honest. Anchor: `lib/data-source/bloomreach-data-source.ts:197,200`.

## See also

- `01-vercel-route-budget.md` — the outer wall these waits eat into
- `03-ttl-cache-no-cache-on-error.md` — why the 60s cache works WITH this mechanism
- `04-progressive-ndjson-stream.md` — what the user sees while waits accumulate
- `audit.md` → `caching-batching-and-backpressure` lens

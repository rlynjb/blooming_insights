# Partial failure, timeouts, and retries

*Industry standard — deadlines, retries, jitter, backoff, and failure classification.*

This is the load-bearing file in the guide. The whole distributed-systems story in `blooming_insights` reduces to: how `BloomreachDataSource` survives a hostile, rate-limited, opaque service it doesn't own. Read this one twice.

## Zoom out — where these mechanisms live

```
  Zoom out — partial failure lives at L3↔L4

  ┌─ L1: Browser ─────────────────────────────────┐
  │  the consumer (sees errors as NDJSON events)   │
  └─────────────────────┬─────────────────────────┘
                        │
  ┌─ L2: Route ─────────▼─────────────────────────┐
  │  surfaces failures as { type: 'error', ... }   │
  └─────────────────────┬─────────────────────────┘
                        │
  ┌─ L3: BloomreachDataSource ──────────────────────┐
  │  ★ THIS FILE LIVES HERE ★                        │  ← we are here
  │  spacing gate · retry ladder · timeout ceiling   │
  └─────────────────────┬───────────────────────────┘
                        │
  ┌─ L4: Bloomreach MCP ▼─────────────────────────┐
  │  rate-limited · token-revoking · sometimes hangs│
  └────────────────────────────────────────────────┘
```

Partial failure is the property that distinguishes a distributed system from a local one: *some* of what you sent worked, *some* didn't, and you have to figure out which. In this codebase, partial failure happens in exactly one place — the wire to Bloomreach — and three mechanisms handle every flavor of it.

## Zoom in — the question this file answers

> When the call to Bloomreach is slow, rejected, hung, or returns an `isError` envelope, what does this code do — and why those specific choices?

Three answers, in dependency order: spacing (don't trip the limit), retry (when you trip it anyway), timeout (when nothing comes back at all). The retry ladder is the most opinionated; you'll spend the most time there.

## Structure pass — the skeleton

### Axes — trace failure

One axis: **what does the code do when the wire returns each shape of failure?** Hold it constant across the five shapes.

```
  One axis: "what shape of failure, what response?"

  Wire returns…                         …code does:
  ─────────────────────────             ────────────────────────────────
  HTTP 2xx, isError=false (happy)        cache + return
  HTTP 2xx, isError=true, "rate limit"   parse hint · sleep · retry (≤3)
  HTTP 2xx, isError=true, other          DON'T cache · return as result
  HTTP 4xx/5xx (transport throw)         tag with McpToolError · throw
  no response for 30s                    AbortSignal.timeout fires · throw
```

The axis-answer flips three times in those five rows. That's where the file's three sections come from: the spacing gate (prevents row 2), the retry ladder (handles row 2), the timeout (handles row 5). Rows 3 and 4 are simpler: surface honestly and don't poison the cache.

### Seams — where the mechanisms attach

The two seams that matter:

```
  Two seams, two mechanisms

  callTool() ──cache miss──► liveCall() ──network──► transport.callTool()
       │                          │                          │
       │                          ▼                          ▼
       │                    SEAM 1: spacing gate +     SEAM 2: AbortSignal.timeout
       │                    rate-limit retry ladder    (per-call 30s ceiling)
       │                    (BloomreachDataSource)     (SdkTransport)
       │
       ▼
  cache (60s, on-success only)
```

Seam 1 lives in `BloomreachDataSource` (`lib/data-source/bloomreach-data-source.ts:139`). Seam 2 lives in `SdkTransport` (`lib/mcp/transport.ts:131`). They're separated on purpose — the retry mechanism doesn't know about the transport timeout, and the transport timeout doesn't know about retries. The contract between them: a transport-level throw is a *terminal* failure for the retry ladder (no retry), and a `HTTP 0: timeout after 30000ms` tag is the signal a hang triggered it.

### Layered decomposition — same axis at two altitudes

```
  Failure containment — held constant top-to-bottom

  outer: route                 → wraps everything in try/catch, sends
                                 `{ type: 'error', message }` NDJSON event
                                 (app/api/briefing/route.ts:289)
  middle: BloomreachDataSource → CONTAINS rate-limit errors via retry;
                                 PROPAGATES transport errors as McpToolError;
                                 NEVER caches errors
  inner: SdkTransport          → CONTAINS timeouts with `HTTP 0:` tag;
                                 PROPAGATES everything else with the
                                 captured server body attached
```

The pattern: each layer *contains what it can*, *propagates with enrichment*, and never *swallows*. The route never sees a generic "fetch failed" — it sees `McpToolError: list_cloud_organizations → HTTP 401: {"error":"invalid_token"}`. That's the discipline.

## How it works

### Move 1 — the mental model

A polite client with a finite patience budget.

> **Three knobs: how far apart you space your calls (`minIntervalMs`), how many times you'll wait and retry when the server explicitly rejects you (`maxRetries`, `retryCeilingMs`), and how long you'll wait for a single response before giving up (`TOOL_TIMEOUT_MS`).** Tune those three for the upstream you're talking to and the time budget you have.

```
  The kernel — one call through BloomreachDataSource

  callTool(name, args, opts)
       │
       ▼
   ┌─────────────────────────────────────────────────────┐
   │  cache lookup (60s, name+args key)                  │
   │     hit?  ──► return { fromCache: true }            │
   │     miss? ──► continue                              │
   └─────────────────────────────────────────────────────┘
       │
       ▼
   ┌─────────────────────────────────────────────────────┐
   │  liveCall(name, args, signal)                       │
   │   1. spacing gate: wait until 1.1s since lastCall    │
   │   2. transport.callTool(…, signal)                   │
   │        signal = compose(opts.signal, 30s timeout)    │
   │   3. update lastCallAt                               │
   │   4. on throw: throw McpToolError(toolName, detail)  │
   └─────────────────────────────────────────────────────┘
       │
       ▼
   ┌─────────────────────────────────────────────────────┐
   │  retry ladder (server says "rate limit")             │
   │     retries < maxRetries?                            │
   │       parsed hint? wait hint+500ms                   │
   │       else?       wait 10s * 2^(retries-1)           │
   │     cap at retryCeilingMs (20s)                      │
   │     ──► back to step 2                               │
   └─────────────────────────────────────────────────────┘
       │
       ▼
   ┌─────────────────────────────────────────────────────┐
   │  cache write (ONLY if isError !== true)              │
   │  return { result, durationMs, fromCache: false }     │
   └─────────────────────────────────────────────────────┘
```

Four parts. The cache exists to absorb same-request duplicate reads (the agents repeat `get_event_schema` across phases). The spacing gate exists so we don't trip the limit. The retry ladder exists for when we trip it anyway. The cache-on-success-only rule exists so a 429 doesn't poison the next request.

### Move 2 — walk it one part at a time

#### Part 1 — the spacing gate (the polite-client knob)

You've thrown `await fetch(url)` in a loop before. The naive version blasts the upstream as fast as JavaScript can dispatch — fine for friendly servers, fatal here. Bloomreach states its window in the rate-limit text ("1 per 10 second"), so we pace ourselves to roughly one request per second to *avoid* the limit on the happy path.

```
  Spacing gate — wait until the floor since the last call

  time:    ─────────────────────────────────────────────►
                   │              │              │
  call:           c1 (sent)      c2 (queued)    c3 (queued)
  arrives:        t=0            t=100ms        t=200ms
  sent at:        t=0            t=1100ms       t=2200ms
                                  ↑              ↑
                       gate held for 1000ms      gate held for 900ms
                       (1100 - 100)              (1100 - 200)
```

The mechanism is one timestamp and one `setTimeout`:

```ts
// lib/data-source/bloomreach-data-source.ts:190-198
private async liveCall(name, args, signal) {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  try {
    const result = await this.transport.callTool(name, args, { signal });
    this.lastCallAt = Date.now();
    return result;
  } catch (err) {
    this.lastCallAt = Date.now();  // ← update even on throw — see below
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}
```

Annotate the parts:
- `this.lastCallAt = Date.now()` runs in *both* the try and the catch branch. If we skipped it in catch, the next retry would have no spacing floor against the failed call and could blast Bloomreach immediately — exactly when we shouldn't.
- The gate is per-`BloomreachDataSource` instance. Each request gets a fresh adapter (see `lib/mcp/connect.ts:94-101`), so the gate resets between requests. We don't share spacing state across instances — Bloomreach's own 429 is the cross-instance source of truth.
- `minIntervalMs: 1100` is set at construction (`lib/mcp/connect.ts:97`). The comment in `connect.ts:86-93` explains the tradeoff: a 10-second spacing floor would blow the route's 60-second budget for a 6-call investigation, so we space at ~1.1s and let the retry ladder catch the times we still trip the limit.

**What breaks if you remove it.** Without the gate, a tight burst of 6 calls from the monitoring agent fires in <100ms. Bloomreach 429s call 2 onward; the retry ladder kicks in for each one; each call's retry waits ~10s; total time for the briefing goes from ~6s to ~60s and you blow the budget. The gate's job is to make the *happy path* fast by avoiding the rate limit, not to handle it.

#### Part 2 — classifying the failure (the rate-limit detector)

Bloomreach returns rate-limit errors as a *successful* HTTP response carrying `isError: true` and a text payload. The detector parses the payload's text for one of two phrases:

```ts
// lib/data-source/bloomreach-data-source.ts:51-71
function isRateLimited(result: unknown): boolean {
  if (!result || typeof result !== 'object' || (result as any).isError !== true) return false;
  const text = JSON.stringify((result as any).content ?? result);
  return /rate limit|too many requests/i.test(text);
}

function parseRetryAfterMs(result: unknown): number | null {
  const text = JSON.stringify((result as any)?.content ?? result);
  const after = text.match(/retry[\s-]*after[^0-9]*(\d+)\s*second/i);
  if (after) return parseInt(after[1], 10) * 1000;
  const perWindow = text.match(/per\s*(\d+)\s*second/i);
  if (perWindow) return parseInt(perWindow[1], 10) * 1000;
  return null;
}
```

Two regexes, two observed shapes:
- `"Retry after ~12 second(s)"` → 12,000 ms (the explicit hint)
- `"rate limit reached (1 per 10 second)"` → 10,000 ms (the penalty window)

If neither matches, the parser returns `null` and the caller falls back to backoff. The test at `test/mcp/client.test.ts:142-167` pins the explicit-hint shape; the test at `:111-140` pins the per-window shape; the test at `:101-109` pins the no-hint fallback.

```
  Failure classification — three buckets, one detector

  result envelope
       │
       ▼
   isError === true?
       │ no                          │ yes
       ▼                              ▼
   happy ──► cache + return        text matches "rate limit"?
                                       │ no                  │ yes
                                       ▼                      ▼
                                 other error: surface     RETRY ELIGIBLE
                                 as result (don't retry,
                                 don't cache)
```

**The honest gap:** classification is regex-on-text. If Bloomreach changes the wording — "throttled" instead of "rate limit" — the detector misses, we skip the retry, the call returns as an error. Tolerable today (the wording has held), risky long-term — file 09 flags it.

#### Part 3 — the retry ladder (the patience budget)

Once classified, the retry mechanism is a bounded loop:

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

Trace it as an execution trace, with `maxRetries=3`, `retryDelayMs=10_000`, `retryCeilingMs=20_000`:

```
  Execution trace — retry ladder against "1 per 10 second" (no explicit hint)

  attempt    retries   hintMs   backoffMs   waitMs    next call
  ────────   ───────   ──────   ─────────   ──────    ─────────
  initial    0         —        —           0         ──► call 1 (rate-limited)
  retry 1    1         null     10_000      10_000    ──► sleep 10s · call 2 (rate-limited)
  retry 2    2         null     20_000      20_000*   ──► sleep 20s · call 3 (rate-limited)
  retry 3    3         null     40_000      20_000*   ──► sleep 20s · call 4 (rate-limited)
  done       3         —        —           —         return last error result

  * capped at retryCeilingMs = 20_000

  total wait in this worst case: 50 seconds inside a 300s route budget
```

Same trace with the explicit hint `"Retry after ~7 seconds"`:

```
  Execution trace — retry ladder with explicit 7s hint

  attempt    retries   hintMs   backoffMs   waitMs    notes
  ────────   ───────   ──────   ─────────   ──────    ────────
  initial    0         —        —           0         call (rate-limited, hint=7000)
  retry 1    1         7_000    10_000      7_500     hint+RETRY_BUFFER_MS, beats backoff
  ────────   ───────   ──────   ─────────   ──────    ────────
```

The 500ms buffer (`RETRY_BUFFER_MS = 500`) lands the retry *just after* the server's stated window clears, not on its boundary — a boundary-aligned retry is the textbook way to hit the same window twice.

Three skeleton parts, named by what breaks if missing:

```
  The retry kernel — name each part by what breaks without it

  the loop bound (retries < maxRetries)
    drop it → unbounded waits, route budget exhausted, server probably
              blacklists you for the pattern

  the wait (hint > backoff)
    drop the hint parse → wait shorter than the server's window, retry
                          hits the same penalty, classified again as rate
                          limit, ladder eats its own attempts
    drop the cap (retryCeilingMs) → backoff doubles to 40s, 80s, …,
                          one call burns the whole route budget

  the buffer (+500ms)
    drop it → retry lands on the window boundary, rolls a coin against
              the server's clock vs ours, ~50% retry on first attempt

  hardening (NOT in the kernel)
    jitter — not currently used; multi-instance bursts theoretically
             align retries to the same instant. Tolerable here because
             the route is the only concurrent caller per session and
             Bloomreach's window is multi-second wide. → see file 09.
```

**What breaks if you remove the bound.** Today, `maxRetries=3` with `retryCeilingMs=20_000` caps the total retry wait at ~50s — comfortably inside the 300s route budget. Drop the bound and the loop is `while(true)` against an upstream that may stay 429 indefinitely. The route's 300s budget would eventually kill it (`maxDuration = 300`), but every other in-flight call on the request would be blocked behind this one. **The bound is what makes one bad call not a route-killing call.**

#### Part 4 — the 30s per-call timeout (the hang ceiling)

The retry ladder assumes calls *return* — either with a result or with an error. A hung call (TCP connection alive, no response coming) defeats that assumption. The transport ceiling fixes it:

```ts
// lib/mcp/transport.ts:38
const TOOL_TIMEOUT_MS = 30_000;

// lib/mcp/transport.ts:129-146
async callTool(name, args, opts) {
  if (this.httpErrors) this.httpErrors.last = null;
  const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
  try {
    return await this.client.callTool({ name, arguments: args }, undefined, { signal });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`HTTP 0: timeout after ${TOOL_TIMEOUT_MS}ms`, { cause: err });
    }
    // … attach captured server body if any …
  }
}
```

Two signals composed, first-to-fire wins:

```
  AbortSignal composition — first-to-fire wins

       route's req.signal                AbortSignal.timeout(30_000)
       (client cancels)                  (per-call ceiling)
            │                                     │
            └──────────────┬──────────────────────┘
                           ▼
                  composeSignals(…)
                  (transport.ts:173)
                           │
                           ▼
                hand to MCP SDK as { signal }
                           │
                           ▼
                whichever fires first triggers abort
                throw → SdkTransport.callTool catches
                isTimeoutError? → tag "HTTP 0: timeout after 30000ms"
```

`composeSignals` (`transport.ts:173-189`) prefers `AbortSignal.any` (Node 20+) and falls back to a manual `AbortController` glue. The composition is what lets *either* a client cancel *or* a 30s ceiling abort the same call.

Why 30 seconds and not 5 or 60? Tradeoff:
- **Too low** (5s) → false positives on slow EQL queries that legitimately take 8-15s under load.
- **Too high** (60s) → a single hung call burns a fifth of the 300s budget; an investigation that does 6 such calls could blow it without ever returning.
- **30s** lands in the middle: well past observed p99 of legitimate calls, well inside a per-call budget that still allows a multi-call investigation to fit.

**Why this error isn't retried.** The comment at `transport.ts:38` calls this out explicitly: the retry ladder only retries `isError: true` results, so a thrown `HTTP 0: timeout` exception fails fast. The reasoning: a retry would just risk another 30s wait inside the same route budget. Better to surface the failure now, let the route emit `{ type: 'error' }`, and let the user decide.

#### Part 5 — the cache-on-success-only rule (don't poison the well)

The final part of the kernel:

```ts
// lib/data-source/bloomreach-data-source.ts:179-187
// Don't cache error results — they should not poison the cache.
if ((result as any)?.isError === true) {
  return { result: result as T, durationMs, fromCache: false };
}

// … write-through cache otherwise …
this.cache.set(cacheKey, { result, expiresAt: now + ttl });
```

This is the smallest mechanism in the file and one of the most important. Without it, a 429 result would be cached for 60s, and every subsequent call with the same `name+args` would *return the cached error envelope* without ever touching the wire — bypassing the retry ladder, freezing the system at the worst possible moment.

**What breaks if you remove it.** A briefing rate-limited on call 1 caches the rate-limit envelope. Calls 2-6 in the same request see `fromCache: true` rate-limit results, the agent loop sees them all as errors, the entire briefing fails. The test at `test/mcp/client.test.ts:89-99` pins this behavior — error results are NOT served from cache on the next call.

### Move 2.5 — current state vs future state

The retry ladder is shipped and tested. Two adjacent improvements are *deferred*, not gated:

```
  Comparison — what's in vs what's deferred

  Phase A (today)                    Phase B (would be defensible to add)
  ─────────────────────────────      ──────────────────────────────────────
  bounded exponential backoff        + jitter (decorrelated, full, equal)
  cap at retryCeilingMs              same (cap stays)
  single-call AbortSignal timeout    + global request-budget AbortController
  no circuit breaker                 + half-open circuit breaker after N
                                       consecutive rate-limit ladder exhaustions
  regex classification               + structured error code from Bloomreach
                                       (server-side change, not ours to make)
```

Jitter is the easiest argument to make: multi-instance bursts under load could theoretically retry-align to the same wake time and re-trip the same window. Today it's tolerable because each browser session opens one stream and Bloomreach's window is multi-second wide; the retry-alignment risk only matters at concurrency we don't have. → file 09 ranks this.

### Move 3 — the principle

> **Spacing prevents the obvious failure; retry handles the unavoidable one; timeout bounds the worst one. Each mechanism has exactly one job, and the kernel works because they don't overlap.**

When you read someone else's retry code and you see the same mechanism trying to handle two of those three jobs, that's the smell. The Bloomreach adapter's retry doesn't handle timeouts (the transport does). The transport doesn't handle rate-limits (the retry does). The cache doesn't override either (it just doesn't cache errors). Three responsibilities, three places.

## Primary diagram — the full kernel

```
  BloomreachDataSource.callTool — the full coordination kernel

  ┌─ caller (agent) ────────────────────────────────────┐
  │  await dataSource.callTool(name, args, { signal })   │
  └──────────────────────┬──────────────────────────────┘
                         │
   ┌─ cache (60s, name+args key) ─────────────────────┐
   │   hit?  ──► return { fromCache: true }           │
   │   miss? ──► fall through                         │
   └──────────────────────┬───────────────────────────┘
                          │
   ┌─ liveCall ──────────▼───────────────────────────┐
   │  spacing gate (wait until 1.1s since lastCall)   │
   │              │                                   │
   │              ▼                                   │
   │  transport.callTool(…, signal)                   │
   │   signal = composeSignals(                       │
   │      opts.signal,                                │
   │      AbortSignal.timeout(30_000),                │
   │   )                                              │
   │              │                                   │
   │              ▼                                   │
   │  try { …return result }                          │
   │  catch (isTimeoutError) → "HTTP 0: timeout 30s"  │
   │  catch (other)          → McpToolError(name, …)  │
   └──────────────────────┬───────────────────────────┘
                          │
   ┌─ retry ladder (isError + "rate limit") ─────────┐
   │  retries < maxRetries(3)?                        │
   │    hintMs = parseRetryAfterMs(result)            │
   │    backoffMs = retryDelayMs * 2^(retries-1)      │
   │    waitMs = min(                                 │
   │      hintMs != null ? hintMs+500 : backoffMs,    │
   │      retryCeilingMs(20_000),                     │
   │    )                                             │
   │    sleep(waitMs); back to liveCall               │
   └──────────────────────┬───────────────────────────┘
                          │
   ┌─ cache-on-success-only ────────────────────────┐
   │   isError? skip cache write; return             │
   │   else     write { result, expiresAt: now+ttl } │
   └──────────────────────┬──────────────────────────┘
                          │
                          ▼
         return { result, durationMs, fromCache: false }

  every NDJSON error event the browser eventually sees
  traces back to one of: a non-rate-limit isError envelope,
  an exhausted retry ladder, or a 30s timeout.
```

## Elaborate

The three mechanisms — spacing, retry, timeout — are the load-bearing trio in every textbook on client-side reliability against an external service. Three references worth knowing:

- **Decorrelated jitter** (AWS Builders Library, "Timeouts, retries, and backoff with jitter"). The canonical case for jitter as a separate concern from backoff base + cap. Not in this codebase today; the case for adding it is in file 09.
- **Circuit breaker** (Release It! — Nygard). Half-open, closed, open states. The pattern is the natural extension of "the retry ladder kept failing": instead of waiting 50s for every call to fail, trip a breaker and fail fast for some window. Defensible to defer here because we have exactly one upstream and an investigation that fails entirely vs partially is acceptable.
- **`AbortSignal.timeout` + `AbortSignal.any`** (WHATWG, Node 20+). The modern primitives that make composeSignals trivial. Worth knowing the fallback path exists in `transport.ts:181-189` for environments without `any` — defensive code that the current runtime doesn't need.

The deeper principle from Hoare via the Erlang community is "let it crash, but contain the blast radius." This file's three mechanisms are exactly that — let the bad calls fail honestly, but never let one bad call burn the whole route budget.

## Interview defense

### "What happens when Bloomreach 429s?"

The 429 isn't actually an HTTP 429 — Bloomreach returns HTTP 200 with an `isError: true` envelope and a text payload like `"rate limit reached (1 per 10 second)"`. The classifier (`isRateLimited` at `bloomreach-data-source.ts:51`) regexes the text; if it matches, the retry ladder takes over: parse the wait hint via `parseRetryAfterMs`, sleep for `hint + 500ms` (capped at `retryCeilingMs = 20_000`), retry. Up to `maxRetries = 3` times, so the worst-case retry wait is ~50s total — comfortably inside the route's 300s budget. If the ladder exhausts, the error result is returned (not cached, so the next call still goes to the wire).

```
  Anchor: bloomreach-data-source.ts:163-174 — the loop
          bloomreach-data-source.ts:179-187 — the don't-cache-errors rule
```

### "How do you keep one slow call from killing the whole request?"

Two ceilings: `AbortSignal.timeout(30_000)` per call (`transport.ts:38`), and `maxRetries=3 × retryCeilingMs=20_000` on retries. The transport-level timeout is composed with the route's `req.signal` via `composeSignals` (`transport.ts:173`), so whichever fires first wins. The route's 300s budget (`maxDuration = 300` in both route files) is the outer envelope — a hung call that triggers the 30s timeout fails fast as `HTTP 0: timeout after 30000ms`, surfaces as `McpToolError`, becomes an `{ type: 'error' }` NDJSON event, and the request completes well inside the budget.

### "Why isn't there jitter?"

Today the system has one concurrent caller per browser session, and Bloomreach's window is multi-second wide. The classic jitter argument — multiple clients retrying in lockstep — doesn't apply because we don't have the lockstep. If two investigations on the same Bloomreach account ever ran in parallel, jitter would become the defensible add. The deferral is named explicitly in file 09. The mechanism that *would* be there if needed: replace `backoffMs` with `Math.random() * backoffMs` (full jitter) or AWS's decorrelated form. The framing matters: jitter is not a bug today; it's a future hardening once concurrency grows.

### "What's the worst-case latency for a single call?"

Add the spacing wait (up to 1.1s) + the first request (up to 30s, the transport ceiling) + the retry wait (up to 20s per retry, capped at `retryCeilingMs`) × `maxRetries` (3 by default) + each retry's request (up to 30s). Math: 1.1 + 30 + 3×(20+30) = ~181s for one tool call in the absolute worst case. Inside the 300s route budget but uncomfortably close. The mitigating factor: this assumes every call hits both the rate limit AND a near-timeout response, which is not the observed steady-state behavior. In practice, calls return in <2s and the ladder is rarely exercised. The 181s number is the budget envelope, not the operating point.

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — why the retry is safe without an idempotency key.
- `04-consistency-models-and-staleness.md` — why the 60s cache is safe across requests.
- `06-queues-streams-ordering-and-backpressure.md` — how errors propagate over the NDJSON wire.
- `09-distributed-systems-red-flags-audit.md` — jitter, breaker, regex-classification gaps ranked.
- `.aipe/study-debugging-observability/` — the per-phase `console.log` summary that exposes when the ladder fires.

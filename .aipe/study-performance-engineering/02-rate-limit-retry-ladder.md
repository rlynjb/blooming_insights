# Rate-limit retry ladder — parse-then-cap

**Industry standard / Language-agnostic**

When the proactive spacing gate (see `01-spacing-gate-vs-backpressure.md`) isn't
enough — clock skew, a quota tightening mid-session, a burst the gate didn't
see — Bloomreach returns a 429 with the penalty window stated inline in the
error envelope. The retry ladder in `BloomreachDataSource.callTool` parses that
window, prefers it over a default exponential backoff, caps every wait at
`retryCeilingMs = 20_000`, and limits to `maxRetries = 3`. This bounds the
worst-case retry cost on any single tool call to ~60s — small enough to fit
inside the 300s route budget even if it fires.

## Zoom out — where this concept lives

The retry ladder sits inside the same `callTool` method that runs the spacing
gate, one level above the live transport call. Two retries fail → the ladder
escalates; the ladder gives up → the error event hits the NDJSON stream and
the UI.

```
  Zoom out — where this concept lives

  ┌─ Service layer ─────────────────────────────────────┐
  │  app/api/{briefing,agent}/route.ts                  │
  │    catches McpToolError → emits error event         │
  └─────────────────────────┬───────────────────────────┘
                            │
  ┌─ Adapter layer ─────────▼───────────────────────────┐
  │  BloomreachDataSource.callTool                       │
  │    1. cache check                                   │
  │    2. liveCall (spacing gate)                       │
  │    3. ★ RETRY LADDER ★   ← we are here              │
  │       while rate-limited && retries < maxRetries    │
  │    4. cache result if not error                     │
  └─────────────────────────┬───────────────────────────┘
                            │
  ┌─ Provider ──────────────▼───────────────────────────┐
  │  Bloomreach loomi connect                            │
  │  429 + "Retry after ~12 second(s)" inline           │
  └─────────────────────────────────────────────────────┘
```

## The structure pass

Trace the axis **"who decides how long to wait?"** across the ladder.

```
  axis = "who decides the next wait?"

  ┌─ failed call ─────────────────────────────────────────┐
  │  liveCall returned an isError:true with rate-limit    │
  │  text in content                                      │
  └──────────────────────────┬────────────────────────────┘
                             │
  ┌─ parseRetryAfterMs ─────▼────────────────────────────┐
  │  PROVIDER decides — if the error text carries a       │
  │  parseable window, use it (plus 500ms cushion)        │
  └──────────────────────────┬────────────────────────────┘
                             │  (nothing parseable?)
  ┌─ exponential fallback ──▼────────────────────────────┐
  │  ADAPTER decides — retryDelayMs × 2^(retry-1)         │
  │  starting at 10_000ms                                 │
  └──────────────────────────┬────────────────────────────┘
                             │
  ┌─ ceiling ───────────────▼────────────────────────────┐
  │  ROUTE BUDGET decides — every wait capped at 20_000ms │
  │  (regardless of what hint or backoff suggested)       │
  └───────────────────────────────────────────────────────┘
```

Three seams: provider-stated wait → exponential fallback → hard ceiling. The
contract that flips at the ceiling is *who owns the cost*: provider says
"wait 30s," but the route's 300s budget owns the final word and refuses to
honor anything above 20s per single retry.

## How it works

### Move 1 — the mental model

You know how `git pull --rebase` will retry with backoff when the remote
returns a conflict, but it gives up after a few tries instead of looping
forever? Same shape: bounded retries, each one bigger than the last (unless
the server told you exactly how long to wait), all capped at a sane maximum,
total attempts bounded.

```
  The pattern — parse, fall back to exponential, cap, count

       result = liveCall(…)
            │
            ▼
       ┌──────────────────────────┐
       │ isRateLimited(result)?   │
       └────────┬─────────────────┘
                │ yes
                ▼
       ┌──────────────────────────┐
       │ retries < maxRetries?    │
       └────────┬─────────────────┘
                │ yes
                ▼
       ┌──────────────────────────────────────────┐
       │ hintMs = parseRetryAfterMs(result)       │
       │ backoff = retryDelayMs × 2^(retries-1)   │
       │ wait = min(hintMs ?? backoff, ceiling)   │
       └────────┬─────────────────────────────────┘
                │
                ▼
            sleep(wait)
                │
                ▼
       result = liveCall(…)   ← retries++
                │
                ▼
            loop or escape
```

Kernel: a `while` loop over `isRateLimited`, a parsed hint, a fallback
backoff, a ceiling, a max-attempts counter. Remove any one and a failure mode
opens up — that's how you tell what's load-bearing.

### Move 2 — the walkthrough

#### Detecting the rate-limit shape

The provider returns a normal `200` envelope with `isError: true` and the
phrase "rate limit" or "too many requests" in the JSON-stringified content.
Detection is a regex over the stringified payload, not an HTTP status check
— because the SDK already swallowed the HTTP layer by the time we see this.

```ts
// lib/data-source/bloomreach-data-source.ts:51-55
function isRateLimited(result: unknown): boolean {
  if (!result || typeof result !== 'object' || (result as any).isError !== true) return false;
  const text = JSON.stringify((result as any).content ?? result);
  return /rate limit|too many requests/i.test(text);
}
```

**What breaks if this misses.** A rate-limit response that doesn't match the
regex falls through as a generic error → the cache-on-success skip
(`bloomreach-data-source.ts:179-181`) ensures we don't cache it, so the next
agent step retries the same call cold. Forward progress, but the retry ladder
never engages and the provider stays angry.

#### Parsing the stated window

Bloomreach states the wait inline. Two shapes are observed; both are parsed:

```ts
// lib/data-source/bloomreach-data-source.ts:64-71
function parseRetryAfterMs(result: unknown): number | null {
  const text = JSON.stringify((result as any)?.content ?? result);
  const after = text.match(/retry[\s-]*after[^0-9]*(\d+)\s*second/i);
  if (after) return parseInt(after[1], 10) * 1000;
  const perWindow = text.match(/per\s*(\d+)\s*second/i);
  if (perWindow) return parseInt(perWindow[1], 10) * 1000;
  return null;
}
```

- `"Retry after ~12 second(s)"` → `12_000`
- `"rate limit reached (1 per 10 second)"` → `10_000`
- Anything else → `null` (caller falls back to backoff)

**What breaks if this returns nothing.** The `??` in the wait calculation
(below) falls through to exponential backoff starting at 10_000ms — usually
fine, but on the third retry the backoff has grown to 40_000ms, which the
ceiling clips to 20_000ms. Net: with a parseable hint you wait ~12s; without
you wait the full 20s ceiling. The hint isn't an optimization, it's how the
ladder respects what the provider actually told it.

#### The wait calculation

This is the load-bearing line of the whole ladder:

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

Three terms compose:

- `hintMs + RETRY_BUFFER_MS` — the parsed window plus a 500ms cushion (so the
  retry lands *just after* the penalty clears, not on its boundary). The
  cushion is the same engineering instinct as the spacing gate's 100ms — clock
  skew is real, defend against it.
- `backoffMs = retryDelayMs * 2 ** (retries - 1)` — the fallback when no hint
  is parseable. `retryDelayMs = 10_000` (set at `lib/mcp/connect.ts:98`)
  matches Bloomreach's observed 10s penalty window, so even the very first
  fallback wait is sized to clear it.
- `retryCeilingMs = 20_000` — the hard ceiling. Whatever the hint or backoff
  suggests, no single retry waits more than 20s. **This is the
  budget-defense knob.**

```
  Execution trace — the worst case

  attempt   isRateLimited?   hintMs    backoffMs   waitMs    cumulative
  ──────────────────────────────────────────────────────────────────────
    1       yes               null      10_000     min(_,20_000)=10_000   10s
    2       yes               null      20_000     min(_,20_000)=20_000   30s
    3       yes               null      40_000     min(_,20_000)=20_000   50s
    4       (max reached)                                                  50s, give up

  → worst case per single tool call: ~50s of retry + the liveCall itself
  → maxRetries=3 stops it from compounding further
```

**Why the ceiling defends the route budget.** Without it, the third retry's
40_000ms backoff would put a single tool call at ~70s of retry cost. Three
such calls in series in one investigation = ~210s = most of the 300s route
budget gone to one provider hiccup. The ceiling says "wait 20s max, then
either succeed or give up."

#### The maxRetries counter

```ts
// implicit in `retries < this.maxRetries` at line 164
this.maxRetries = opts.maxRetries ?? 3;  // line 132, then overridden at connect.ts:100
```

**What breaks without it.** The `while` becomes an unbounded loop. A
genuinely angry provider (quota lowered, account suspended, anything that
makes every retry also rate-limited) would loop forever — well, until the
route's 300s ceiling kills the process. Bounded retries make the failure
visible quickly instead of silently consuming the route.

#### The no-cache-on-error rule (touches this seam)

If the ladder gives up still rate-limited, the result is `isError: true` and
the cache write is skipped:

```ts
// lib/data-source/bloomreach-data-source.ts:179-181
if ((result as any)?.isError === true) {
  return { result: result as T, durationMs, fromCache: false };
}
```

So a 429 that the ladder couldn't recover doesn't poison the next minute of
retries. The next call comes in fresh, the spacing gate releases it normally,
and the ladder gets another full attempt. → see
`04-response-cache-with-no-cache-on-error.md` for the cache side of this.

### Move 3 — the principle

The principle: **a retry policy is a budget allocator, not a recovery
mechanism.** The retry ladder doesn't promise the call succeeds; it promises
the call doesn't eat more than `maxRetries × retryCeilingMs` worth of
upstream budget. That's the contract you can defend to the route layer.
Recovery is best-effort; budget defense is the actual job.

Two corollaries:

1. **Prefer provider-stated waits over guessed ones.** A regex parse against
   the error envelope costs almost nothing and tunes itself to whatever the
   provider's window currently is. If they tighten the quota, the parse
   tracks it; your fixed backoff doesn't.
2. **Cap, even when you trust the provider.** The cushion-plus-cap pattern
   (`min(hint + cushion, ceiling)`) means a provider that suggests "wait 5
   minutes" can't actually make you wait 5 minutes. You'll fail loudly
   instead — which is the right outcome when the budget you're defending is
   smaller than the provider's suggestion.

## Primary diagram

```
  Rate-limit retry ladder — full picture

  callTool(name, args, options):
    │
    ├─ cache check (skip on cache hit)
    │
    ├─ result = liveCall(name, args, signal)   ← spacing gate runs here
    │
    ├─ retries = 0
    │
    ├─ while isRateLimited(result) && retries < maxRetries:
    │     │
    │     ├─ retries++
    │     │
    │     ├─ hintMs = parseRetryAfterMs(result)
    │     │            │
    │     │            ├─ "Retry after ~12 second(s)"  → 12_000
    │     │            ├─ "rate limit (1 per 10 second)" → 10_000
    │     │            └─ none parseable                → null
    │     │
    │     ├─ backoffMs = retryDelayMs × 2^(retries-1)
    │     │              = 10_000 → 20_000 → 40_000
    │     │
    │     ├─ waitMs = min(
    │     │            hintMs ? hintMs + 500 : backoffMs,
    │     │            retryCeilingMs    ← 20_000 — the cap
    │     │          )
    │     │
    │     ├─ sleep(waitMs)
    │     │
    │     └─ result = liveCall(name, args, signal)
    │
    ├─ if result.isError → return without caching
    │
    └─ cache.set(key, { result, expiresAt: now + 60s })
       return result

  Worst-case wall-clock on a single failing call:
    spacing wait (≤1.1s) + liveCall + 3 × (20s + liveCall)
    ≈ 60s of retry waits + 4 × per-call latency
    bounded above by 60s + 4 × 30s = 180s (per-call timeout is 30s)
    — still under 300s route budget, by design
```

## Elaborate

**Where this pattern comes from.** Retry-with-backoff is older than HTTP —
it appears in TCP's RTO algorithm (Van Jacobson 1988). The
"prefer-provider-hint-over-guess" half traces to the HTTP `Retry-After`
header (RFC 7231 §7.1.3); the regex-parse-from-body form here is just a
workaround for Bloomreach stating the hint in the error text instead of a
header. The combination — bounded retries × per-retry cap × provider-hint-
preferred — is the AWS SDK's default retry strategy in essence, scaled down
to one tool call.

**Why three retries, not five.** Three was chosen against the 300s route
budget at the connect site (`lib/mcp/connect.ts:100`). Five retries × 20s
ceiling = 100s per call, and a typical investigation makes 6+ calls. Three
retries × 20s = 60s, comfortably bounded. Could be tuned upward if the route
budget grew, or downward if you wanted faster failure.

**The 500ms cushion lives in `RETRY_BUFFER_MS`.** Defined at
`lib/data-source/bloomreach-data-source.ts:49` as a named constant with an
explicit comment ("so the retry lands just *after* the penalty clears rather
than on its boundary"). Same engineering instinct as the spacing gate's
100ms — clock skew is real, defend against it.

**No exponential-on-hint.** The ladder doesn't *grow* the hint between
retries; it just waits exactly as long as the hint said (plus the cushion,
capped at ceiling). The exponential growth only kicks in on the fallback
backoff path. This matters: if the provider says "wait 10s," a third retry
also waits 10s, not 40s. The provider is the authority on its own quota.

**No interaction with `AbortSignal` mid-wait.** The `sleep(waitMs)` call
(`bloomreach-data-source.ts:172`) uses a plain `setTimeout`-based promise that
doesn't honor the route's `req.signal`. A client navigating away during a 20s
retry wait won't cancel the wait — the next `liveCall` will fail-fast on the
aborted signal, but the wait runs to completion. Not a problem today (the
route budget is the real ceiling), but worth knowing.

## Interview defense

**Q: Walk me through your retry strategy.**

The data-source adapter wraps each MCP call in a bounded retry ladder. When
the provider returns a rate-limit envelope, we parse the stated wait window
out of the error text — Bloomreach writes it inline, two shapes both handled.
If parsing succeeds we wait that exact window plus a 500ms cushion so we
land just after the penalty clears, not on its boundary. If parsing fails,
we fall back to exponential backoff starting at 10s. Every wait, hint or
backoff, is capped at a 20s ceiling — and we give up after 3 retries.

The kernel is: parse → fall back to exponential → cap → count. Remove any
one and a failure mode opens. Drop the cap and a third retry's 40s backoff
puts one tool call at 70s of upstream budget — three such calls and the
route budget is gone. Drop the counter and a genuinely angry provider
loops until the route timeout kills it.

The interview tell most people miss: **the parsed hint is preferred over
backoff but not grown between retries.** A third retry on the same hint
waits exactly the hint, not 4× the hint. The provider is the authority on
its own quota.

```
  Sketch — worst case per call

  waits: 10s + 20s + 20s = 50s    (maxRetries=3, ceiling=20s)
  + per-call timeout                30s (each liveCall bounded)
  → bounded above at ~80-90s/call, fits the 300s route budget
```

Anchor: `lib/data-source/bloomreach-data-source.ts:163-188`.

**Q: Why a parsed hint instead of just backoff?**

Bloomreach's quota changes between "1 per 1 second" and "1 per 10 second"
depending on which tool you're calling. A fixed backoff that worked for one
window is wrong for the other. The parsed hint self-tunes: when the provider
says "wait 12s," waiting 12s succeeds; when the provider says "wait 1s,"
waiting 1s succeeds. Fixed backoff has to choose a number that's safe for the
worst case — which means slow for the common case.

The cost of the parse is a regex over a JSON-stringified payload, negligible.

**Q: What's the relationship to the spacing gate?**

They're the two halves of the same trade. The spacing gate (1.1s between
calls) is the *proactive* defense — pay a small steady tax to honor the
quota. The retry ladder is the *reactive* recovery — when proactive isn't
enough, parse what the provider said and pay the penalty. The design comment
at `connect.ts:86-93` is explicit: spacing at the worst-case 10s window would
cost ~60s for a 6-call investigation and blow the route budget, so the
design accepts the occasional 429 and pays a parsed retry wait instead of
pre-paying every call.

## See also

- `01-spacing-gate-vs-backpressure.md` — the proactive half of the same trade.
- `03-per-call-timeout-ceiling.md` — the orthogonal ceiling: `liveCall` itself
  can't exceed 30s, so a "hung" call inside a retry loop doesn't compound.
- `04-response-cache-with-no-cache-on-error.md` — why errors aren't cached
  even when the ladder gives up.
- `../study-distributed-systems/` — partial-failure semantics under provider
  degradation (what "best-effort retry" actually means).

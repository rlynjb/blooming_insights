# 02 · Spacing gate & retry ladder

**Client-side rate limiting + adaptive retry · Industry standard.**
Sometimes called *token-bucket smoothing* + *server-hint retry-after*.

## Zoom out — where these two live

Bloomreach rate-limits per user globally and states the penalty
window in the error text. The repo defends against it in two
different places, with two different mechanisms.

```
  Zoom out — the two mechanisms at the MCP boundary

  ┌─ Agent (ReAct loop) ─────────────────────────────────────────┐
  │  DiagnosticAgent.investigate → tool_use → dataSource.callTool │
  └─────────────────────────────────────┬────────────────────────┘
                                        │
  ┌─ Bloomreach adapter (data-source) ──▼────────────────────────┐
  │  BloomreachDataSource.callTool                                │
  │                                                                │
  │   ★ 1. THE SPACING GATE (scheduler, proactive) ★              │
  │   liveCall() waits so calls are ≥ 1.1s apart                  │
  │                                                                │
  │   ★ 2. THE RETRY LADDER (backpressure, reactive) ★            │
  │   parses "retry after ~12 seconds" out of 429 error text     │
  │   waits, retries, cap 20s per, max 3 retries                  │
  └─────────────────────────────────────┬────────────────────────┘
                                        │  HTTPS
  ┌─ MCP server (Bloomreach loomi) ─────▼────────────────────────┐
  │  1 request per second global limit per user                   │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in — the load-bearing distinction.** These are two different
mechanisms, not two settings of the same one. The spacing gate is
a *scheduler* applied to every call before it goes out. The retry
ladder is *backpressure*, reactive, only fires when a 429 comes
back. Confusing them is the perf trap that keeps engineers writing
the same over-throttled or under-throttled code forever.

## Structure pass — layers, axis, seams

**Layers.** Call-site (agent) → gate (`liveCall` pre-await) → retry
loop (`callTool` while-loop) → transport (fetch).

**Axis: when does the wait happen — before the call or after the
failure?**

```
  Axis — "when does the wait happen?"

  ┌─ spacing gate ─────────────┐   ┌─ retry ladder ──────────────┐
  │  wait BEFORE the call       │   │  wait AFTER a 429 comes back │
  │  every call pays it         │   │  only failures pay it        │
  │  prevents 429s               │   │  recovers from 429s          │
  │  fixed interval              │   │  server-hinted, variable     │
  └─────────────────────────────┘   └──────────────────────────────┘
       proactive · scheduler              reactive · backpressure
```

**Seams.** The seam is inside `BloomreachDataSource.callTool`
(`lib/data-source/bloomreach-data-source.ts:139-188`) — the same
function houses both mechanisms, but they're structurally separate
code paths. The gate lives in `liveCall` (called at `:155,173`);
the retry loop wraps `liveCall` in a `while (isRateLimited(...))`.
That structural separation is the code encoding of the axis
distinction.

## How it works

### Move 1 — the mental model

You already know how `setTimeout(fn, 100)` throttles a UI event to
one call per 100ms. The spacing gate is that primitive at the API
boundary — every call waits until at least 1.1s has passed since
the last one. Simple. The retry ladder is a completely different
primitive: it only runs when the server pushes back, and it does
what the server said to do.

```
  Pattern — spacing gate + retry ladder as separate paths

     call arrives ─┐
                   │  gate wait: max(0, 1100 - elapsed)ms
                   ▼
              ┌────────┐
              │ fetch  │───► 200 OK ─────────► return result
              └───┬────┘
                  │ 429
                  ▼
              parse retry-after: e.g. 12s → wait 12.5s
                  ▼
              ┌────────┐
              │ fetch  │───► 200 OK ─────────► return result
              └───┬────┘   (or 429 → wait again, max 3 times)
                  │
                  ▼
              retries exhausted → return the 429 as the result
```

**The skeleton part everyone forgets.** The spacing gate uses a
**fixed** interval (1.1s). The retry ladder uses a **variable**
wait parsed from the server response, capped at retryCeilingMs.
Falling back to an exponential backoff off retryDelayMs = 10s when
the server hint isn't parseable is the *hardening*, not the
kernel. The kernel is: wait what the server told you to wait, then
retry. Without the retry loop, the whole system falls back to
"just space calls further apart" — which the comment at
`connect.ts:113-115` calls out as blowing the route budget.

### Move 2 — walking each mechanism

#### The spacing gate — `liveCall` pre-await

Set at construction (`lib/mcp/connect.ts:121`):

```ts
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

Enforced at `lib/data-source/bloomreach-data-source.ts:190-194`:

```ts
private async liveCall(name, args, signal): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  // …then dispatch the real transport call
```

**Why 1.1s instead of full 10s.** The observed Bloomreach window
is 10s; a 10s spacing gate would cost `10s × 6 calls = 60s` for a
6-call investigation and blow the 300s route (comment at
`connect.ts:112-117` names this). 1.1s is chosen as a proactive
smoothing floor — enough to avoid the trivial 1-per-second window,
short enough that the ~10s window is instead handled reactively by
the retry ladder. That's the design decision the axis distinction
enables.

**What the gate is NOT.** It is not a token bucket. It doesn't
accumulate credit for idle periods. It's a plain "no two calls
within X ms of each other" gate, tracked by `lastCallAt`
(`bloomreach-data-source.ts:123`). Simpler, correct for this shape
of workload, no bucket math to get wrong.

#### The retry ladder — `callTool` while loop

At `lib/data-source/bloomreach-data-source.ts:163-174`:

```ts
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

**Preference order — server hint, then backoff, always capped.**
`hintMs` comes from parsing the error text
(`bloomreach-data-source.ts:64-71`): `Retry after ~12 second(s)` →
12000ms; `(1 per 10 second)` → 10000ms. When the hint parses, use
it (plus a 500ms `RETRY_BUFFER_MS` cushion so the retry lands
*after* the penalty clears, not on its boundary). When it doesn't
parse, exponential backoff off `retryDelayMs = 10_000`. Both are
capped at `retryCeilingMs = 20_000` because a stated 60s window
would eat the whole route budget for one call.

**Why the retry ladder RE-ENTERS `liveCall`.** Look at
`bloomreach-data-source.ts:173`: the retry `await`s
`this.liveCall(name, args, options.signal)` — which means the
spacing gate fires again before the retry. That's correct: after a
429 the next call must also respect the spacing gate; otherwise
the retry would land inside the just-cleared penalty window.
Composition of the two mechanisms is enforced by the code
structure, not by a rule.

#### The observability trap

`sleep(waitMs)` blocks the async execution but does NOT count
against `budget.exceeded()` — the tracker checks tokens, not wall
clock. So a retry-heavy call is invisible to the cost ceiling.
This is fine (retries don't cost money), but it's the reason the
route-level phase log matters: `diagnostic_investigate: 240_000ms`
tells you retries burned the budget when the cost dashboard shows
a normal spend. Cross-link to `05-budget-ceiling-check-before-dispatch.md`.

### Move 3 — the principle

Two axes need two mechanisms. **Prevention vs recovery.** Trying to
solve rate limits with a single "wait longer" knob either
over-throttles the happy path (spacing set to the failure window)
or under-defends the failure path (spacing set short, no retry).
Splitting the problem into a proactive scheduler + a reactive
retry ladder is what lets each mechanism be tuned for its own
axis — and what makes the perf story defensible when the numbers
don't line up.

## Primary diagram

```
  The two mechanisms, one call

  ┌─ callTool(name, args) ────────────────────────────────────────┐
  │                                                                │
  │   cache check ─────► hit? → return { fromCache: true }         │
  │        │ miss                                                  │
  │        ▼                                                       │
  │   ★ SPACING GATE (proactive) ★                                 │
  │   wait(max(0, 1100 - elapsed))                                 │
  │        │                                                       │
  │        ▼                                                       │
  │   liveCall → transport → server                                │
  │        │                                                       │
  │        ├─ 200 → cache write-through → return                   │
  │        │                                                       │
  │        └─ 429 (rate limited)                                   │
  │             │                                                  │
  │             ▼                                                  │
  │   ★ RETRY LADDER (reactive) ★                                  │
  │   for retries = 1..3:                                          │
  │     wait = min(hintMs+500 || 10s×2^(r-1), 20s)                 │
  │     re-enter liveCall (spacing gate fires again)               │
  │     if not 429: cache write-through → return                   │
  │                                                                │
  │   retries exhausted: return the 429 as the result              │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where the pattern comes from.** The pairing of a token bucket
(smoothing) with server-hinted retry (`Retry-After` header) is
standard in HTTP client libraries — see AWS SDKs' adaptive retry,
Google Cloud client libraries' RPC retry policies. The Bloomreach
case is unusual only in that the retry hint is in the error TEXT,
not a header, so the code parses text patterns instead of reading
`response.headers.get('retry-after')`.

**Why the spacing gate isn't a token bucket.** A token bucket
carries state across idle periods — if you don't call for 10
seconds, you can burst 10 calls at once. This shape of workload
doesn't want bursts: the Bloomreach limit is 1/s global and doesn't
"refill" credits. A plain lastCallAt-based gate is the simpler
correct shape.

**Cross-link.** `study-runtime-systems` explains what happens during
`await new Promise(r => setTimeout(r, ms))` — it's not "blocking";
it's yielding the event loop. This matters when you think about
concurrent investigations: the spacing gate is per-instance-of-
BloomreachDataSource, not global, so two concurrent investigations
on the same instance would race the gate.

## Interview defense

### Q1 · "Walk me through your rate-limiting."

**Answer.** Two mechanisms, one for prevention and one for
recovery. The spacing gate keeps at least 1.1 seconds between
calls proactively — before every fetch, `liveCall` awaits the
difference between the last call and now. That's the scheduler
part. The retry ladder is separate: when a 429 comes back, we
parse the "retry after X seconds" text out of the error body, wait
that long plus 500ms, and retry — up to 3 times, each capped at
20s so a stated 60s window doesn't eat the whole route budget.
The 1.1s spacing is chosen deliberately below the observed 10s
window because a 10s gate would blow the 300s route on a 6-call
investigation.

```
  gate: proactive        │  retry: reactive
  every call waits        │  only 429s wait
  fixed 1.1s              │  server-hinted, capped at 20s
  keeps you off the       │  gets you off the ledge you
  ledge                    │  landed on anyway
```

**One-line anchor.** "Prevention is the gate; recovery is the
ladder — different axes, different mechanisms."

### Q2 · "What if the server says wait 60 seconds?"

**Answer.** The retry ladder caps at `retryCeilingMs = 20_000`
(`bloomreach-data-source.ts:136`). A 60s hint gets truncated to
20s and we retry. If we're still 429ing, we retry twice more at
20s each, then bubble the 429 back as the result. The agent sees
it and reasons about what to do next — either try a different tool
or produce a diagnosis noting the outage. The cap exists because
the 300s route budget can't afford one call spending 60s waiting;
we'd rather fail the call and let the agent adapt.

**One-line anchor.** "Cap the retry so the outer budget still
has room to fail gracefully."

### Q3 · "What breaks if you remove the spacing gate and just rely on the retry ladder?"

**Answer.** The retry ladder is bounded — 3 retries × 20s cap = 60s
of retry budget. Without proactive spacing, the happy path hits
429s constantly and burns that budget on every call. A 6-call
investigation could easily spend `6 × 60s = 360s` in retries,
blowing the route. The gate is the prevention layer: it keeps the
happy path from ever hitting the 429 in the first place, so the
retry ladder stays a rare-event backup, not the hot path.

**One-line anchor.** "Retries are the backup, not the plan."

## See also

- `01-route-budget-and-timeout-composition.md` — why the 20s cap
  and 3-retry limit exist (the outer 300s budget).
- `04-response-cache-ttl.md` — the layer above spacing that
  absorbs duplicate calls entirely.
- `study-networking` — HTTP `Retry-After` semantics as the
  standard version of what Bloomreach does in text.
- `study-system-design` — why the ~1 req/s global limit shapes
  the whole architecture, not just this file.

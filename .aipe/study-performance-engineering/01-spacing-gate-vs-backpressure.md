# Spacing gate vs backpressure — `minIntervalMs = 1100`

**Industry standard / Language-agnostic**

The single most load-bearing performance number in the repo is also the most
commonly mis-labelled. The `minIntervalMs = 1100` set in `lib/mcp/connect.ts:97`
is a **spacing gate** enforcing **rate-limit compliance** with an external
provider's quota — it is **not** backpressure. The distinction matters because
the two patterns answer different questions, get tuned by different signals, and
fail in different ways.

## Zoom out — where this concept lives

The spacing gate sits one layer below your agent code and one layer above the
network. Every MCP tool call funnels through it before reaching the provider.

```
  Zoom out — where this concept lives

  ┌─ UI layer ──────────────────────────────────────────┐
  │  app/page.tsx, components/feed/*                    │
  └─────────────────────────┬───────────────────────────┘
                            │  fetch() — NDJSON
  ┌─ Service layer ─────────▼───────────────────────────┐
  │  app/api/{briefing,agent}/route.ts                  │
  │    agents → dataSource.callTool(...)                │
  └─────────────────────────┬───────────────────────────┘
                            │
  ┌─ Adapter layer ─────────▼───────────────────────────┐
  │  BloomreachDataSource.callTool                       │
  │    1. cache check                                   │
  │    2. ★ liveCall → SPACING GATE ★   ← we are here   │
  │    3. retry on 429                                  │
  └─────────────────────────┬───────────────────────────┘
                            │  HTTPS
  ┌─ Provider ──────────────▼───────────────────────────┐
  │  Bloomreach loomi connect MCP server                │
  │    enforces ~1 req/s global per user                │
  └─────────────────────────────────────────────────────┘
```

The 1.1s figure isn't borrowed from a tutorial — it's the observed Bloomreach
penalty window (`"1 per 1 second"` in their 429 envelope) plus a 100ms safety
cushion. The cushion exists because clock skew + the spacing gate's
last-call-at timestamp aren't the same clock the provider uses to decide.

## The structure pass — read the skeleton before the mechanics

The right axis to trace is **control of timing** — who decides when the next
call goes out, and what signal drives the decision.

```
  Trace "who decides when the next call goes" across the three boundaries

  ┌─ agent loop ──────────────────────────────────────────┐
  │  AGENT decides — "I want to call execute_analytics_eql"│
  └────────────────────────┬──────────────────────────────┘
                           │  seam: BloomreachDataSource.callTool
                           ▼
  ┌─ spacing gate ────────────────────────────────────────┐
  │  THE GATE decides — "not until 1.1s after the last"   │
  │  ← decision driven by INTERNAL CLOCK, NOT consumer    │
  └────────────────────────┬──────────────────────────────┘
                           │  seam: SDK transport / HTTPS
                           ▼
  ┌─ provider ────────────────────────────────────────────┐
  │  PROVIDER decides — "accept, or 429 with hint"        │
  └───────────────────────────────────────────────────────┘
```

Two seams, two contracts. The agent → gate seam is a **time-based admission
contract**: the agent submits work, the gate releases it on its own schedule.
The gate → provider seam is a **rate-limit contract**: stay under N req/s or
we 429 you. These are the two seams the spacing gate sits between.

The axis-flip that matters: at the agent → gate seam, control flips from
"agent decides" to "gate decides." That's the load-bearing seam — the gate's
decision is not influenced by the agent's urgency, the provider's load, or any
consumer-side signal. **It's driven by an internal clock alone.** That makes
it a spacing gate, not backpressure.

## How it works

### Move 1 — the mental model

You've used `setTimeout` to debounce a button. Same shape, scaled up: the
spacing gate is a debounce on outbound network calls — except the threshold
isn't "wait until the user stops typing," it's "wait until ≥ 1100ms has passed
since the last call landed."

```
  The pattern — a one-counter spacing gate

  state: lastCallAt   (epoch ms of the last live call)
  knob:  minIntervalMs (1100)

  on each new call:

           ┌──────────────────────────────┐
           │ elapsed = now - lastCallAt   │
           └──────────────┬───────────────┘
                          │
              elapsed < minIntervalMs ?
            ┌─────────────┴─────────────┐
           yes                          no
            │                            │
            ▼                            ▼
       sleep(minIntervalMs - elapsed)  proceed immediately
            │                            │
            └─────────────┬──────────────┘
                          ▼
                    do the live call
                          │
                          ▼
                lastCallAt = now()       ← updated after the call,
                                            so a slow call shifts
                                            the next departure forward
```

The kernel: one timestamp + one threshold + one conditional sleep. That's the
whole pattern. Everything else (caching, retries, timeouts) is hardening built
on top.

### Move 2 — the walkthrough

#### The one-counter timer

The gate's entire state is **one timestamp** and **one threshold**. Both live
on the `BloomreachDataSource` instance, which is per-request — so a fresh request
starts with `lastCallAt = 0` (every call is "old enough" → no wait).

```ts
// lib/data-source/bloomreach-data-source.ts:122-137
export class BloomreachDataSource implements DataSource {
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
  private lastCallAt = 0;          // ← the entire timing state
  private minIntervalMs: number;
  // ...
  constructor(private transport: McpTransport, opts: ClientOpts = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 200;
    // ...
  }
}
```

`minIntervalMs` defaults to `200` in the class, then gets overridden to `1100`
at the connect site:

```ts
// lib/mcp/connect.ts:94-101
return {
  ok: true,
  mcp: new BloomreachDataSource(new SdkTransport(client, httpErrors), {
    minIntervalMs: 1100,                  // ← the load-bearing number
    retryDelayMs: 10_000,
    retryCeilingMs: 20_000,
    maxRetries: 3,
  }),
};
```

**What breaks if the timestamp is missing.** No `lastCallAt` → no elapsed-time
calculation → every call goes out immediately → the second call lands inside
the provider's 1s penalty window → 429 → retry ladder fires. The retry ladder
recovers eventually but pays 10-20s per fired retry. So: without the timestamp,
the system still works, but worst-case throughput collapses from "1 req/s
honored" to "1 req per ~12s after a 429 cascade."

#### The conditional sleep

Inside `liveCall`, the gate computes how long ago the last call went out and
sleeps for the remainder if it's too soon.

```ts
// lib/data-source/bloomreach-data-source.ts:190-205
private async liveCall(name, args, signal?: AbortSignal): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  try {
    const result = await this.transport.callTool(name, args, { signal });
    this.lastCallAt = Date.now();          // ← updated AFTER the call returns
    return result;
  } catch (err) {
    this.lastCallAt = Date.now();          // ← also updated on failure
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}
```

Notice `lastCallAt` is updated **after** the call returns (success or failure),
not before it's sent. That means a slow call effectively widens the spacing —
the next call's `elapsed` starts ticking from when the previous call **finished**,
not when it started. This is intentional: it prevents the gate from queueing
many in-flight calls at the spacing interval and then having them all land at
the provider in a burst when the network catches up.

```
  Layers-and-hops — what one call's timing looks like

  ┌─ caller ──────┐  agent.investigate()
  │  agent loop   │ ─────────────┐
  └───────────────┘              │ submit at t=0
                                 ▼
  ┌─ adapter ─────────────────────────────┐
  │  callTool()                            │
  │    ├─ cache check (miss)               │
  │    ├─ liveCall:                        │
  │    │    elapsed = 200ms                │
  │    │    sleep(900ms)  ← spacing gate   │  hop 1: wait
  │    │    transport.callTool(…)          │  hop 2: HTTPS req
  │    │    [provider 400ms]               │
  │    │    lastCallAt = t=1300ms          │  hop 3: HTTPS resp
  │    └─ return result                    │
  └────────────────────────────────────────┘
                                 │
                                 ▼
                          next call may proceed from t=1300ms
                          (not t=200ms — slow calls widen spacing)
```

**What breaks if you update `lastCallAt` before the call.** The next call's
spacing starts ticking immediately — so if you queue 6 calls back-to-back, you
spread their submission across 6 × 1.1s = 6.6s, but they might all land at the
provider within a 500ms window if the network was queued. Bursts kill the
quota.

#### Why 1100ms, not 1000ms

The provider's stated window is "1 per 1 second." If your spacing is exactly
1000ms, then `Date.now()` skew on either side — yours or theirs — can put two
calls inside the same penalty window. The 100ms cushion is the safety margin
that absorbs that skew without giving up meaningful throughput.

You can see the design intent in the comment block at `lib/mcp/connect.ts:86-93`:

```ts
// Bloomreach rate-limits per user GLOBALLY and states the window in the
// error text — observed as both "(1 per 1 second)" and "(1 per 10 second)".
// Proactive spacing stays at ~1.1s on purpose: spacing at the full 10s
// window would cost ~60s for a 6-call investigation and blow the route's
// 60s budget (app/api/agent). Instead, BloomreachDataSource parses the stated
// window from each 429 and waits it out on retry (see retryDelayMs/retryCeilingMs),
// and the 60s response cache absorbs repeats.
```

This is the load-bearing trade made explicit: **don't pay the worst case
proactively** (the 10s penalty), **pay the common case** (the 1s window) and
recover from the worst case reactively. The retry ladder + the response cache
exist to make this trade safe — see `02-rate-limit-retry-ladder.md` and
`04-response-cache-with-no-cache-on-error.md`.

#### The distinction that earns this file its name

This is a spacing gate. It is not backpressure. The two are constantly
conflated and the conflation is a tuning hazard.

```
  Comparison — spacing gate vs backpressure

  ┌─ SPACING GATE (what this file is) ────────────────────────┐
  │  Question answered: "am I exceeding a provider quota?"   │
  │  Signal driving the decision: INTERNAL CLOCK             │
  │  Knob: minIntervalMs (provider's quota window)           │
  │  Failure mode if wrong: 429 from provider                │
  │  Tuned by: the provider's stated rate limit              │
  │  Consumer-side info used: NONE                           │
  └──────────────────────────────────────────────────────────┘

  ┌─ BACKPRESSURE (NOT what this file is) ────────────────────┐
  │  Question answered: "is my consumer keeping up?"         │
  │  Signal driving the decision: CONSUMER SIGNAL            │
  │    (queue depth, lag, watermark, ack ratio)              │
  │  Knob: queue capacity, lag threshold, water mark         │
  │  Failure mode if wrong: consumer OOMs or falls behind    │
  │  Tuned by: consumer's drain rate                         │
  │  Consumer-side info used: ESSENTIAL                      │
  └──────────────────────────────────────────────────────────┘
```

If you mis-label the spacing gate as backpressure, you'll reach for the wrong
signal when it misbehaves: you'll instrument queue depth (there is none),
you'll tune against consumer lag (irrelevant), and you'll miss the actual
failure path (the provider's 429). The gate has no consumer to back-pressure
against. The provider isn't a slow consumer — it's an external authority with
a quota.

The honest test: **what signal would tell you the knob is set wrong?**
- Spacing gate wrong: rising 429 count in the provider's response stream.
- Backpressure wrong: rising queue depth / consumer lag.

In this repo, the signal lives in `lib/data-source/bloomreach-data-source.ts:51-55`'s
`isRateLimited()` and the retry counter inside `callTool`. That's the spacing
gate's failure signal. There is no queue, no consumer signal, no watermark —
because there's no backpressure to manage.

### Move 3 — the principle

The principle that generalises: **when you place a timing gate, name the
question it answers.** Two gates can look identical in code (one timestamp,
one threshold, one conditional sleep) and serve completely different patterns.
The label is not cosmetic — it determines which signal you instrument, which
knob you tune, and which failure mode you watch for.

In a system with both: a spacing gate guards your outbound calls against
provider quotas; backpressure guards your inbound work against your own
consumer's drain rate. They compose; they don't substitute.

## Primary diagram

```
  The spacing gate, full picture

  ┌─ agent layer ─────────────────────────────────────────────┐
  │  MonitoringAgent.scan  /  DiagnosticAgent.investigate     │
  │  RecommendationAgent.propose  /  QueryAgent.answer        │
  │                                                            │
  │  for each step:                                            │
  │    dataSource.callTool(name, args, { signal })             │
  └──────────────────────────────┬────────────────────────────┘
                                 │
  ┌─ BloomreachDataSource ──────▼────────────────────────────┐
  │                                                            │
  │  callTool(name, args):                                     │
  │    1. cacheKey = name + JSON.stringify(args)               │
  │    2. if cache hit & not skipCache → return cached         │
  │    3. result = liveCall(name, args, signal)                │
  │    4. while rate-limited && retries < 3:                   │
  │         waitMs = min(parsedHint ?? backoff, 20_000)        │
  │         sleep(waitMs)                                      │
  │         result = liveCall(…)                               │
  │    5. cache.set(key, { result, expiresAt: now + 60s })     │
  │                                                            │
  │  liveCall(name, args, signal):     ← ★ THE SPACING GATE ★  │
  │    elapsed = now - lastCallAt                              │
  │    if elapsed < 1100:                                      │
  │      sleep(1100 - elapsed)                                 │
  │    result = transport.callTool(name, args, { signal })     │
  │    lastCallAt = now()      ← AFTER, so slow calls widen    │
  │    return result                                           │
  │                                                            │
  └──────────────────────────────┬────────────────────────────┘
                                 │  HTTPS via SdkTransport
                                 │  + AbortSignal.timeout(30s)
  ┌─ Bloomreach provider ───────▼────────────────────────────┐
  │  loomi connect MCP server                                  │
  │  enforces ~1 req/s GLOBAL per user                         │
  │  429 + Retry-After hint on violation                       │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

**Origin.** The spacing-gate pattern predates the term — it's how every
single-counter rate limiter on the *client* side works (the AWS SDK exponential
backoff defaults, GitHub's secondary rate limit guidance, every Discord/Twitter
bot tutorial that warned you about getting your IP shadow-banned). The
"token bucket" formulation generalises it (B tokens, refill rate R), but for
the single-thread, single-counter case in this repo the simpler
last-call-timestamp form is identical in behavior and trivially smaller.

**Why this isn't a leaky bucket either.** A leaky bucket maintains a queue and
drains at a fixed rate — bursts up to bucket capacity are absorbed. The spacing
gate here doesn't maintain a queue; if two calls arrive at the gate within
1.1s, the second one's awaiting promise simply waits. There's no buffer
overflow because there's no buffer.

**The tuning conversation.** If Bloomreach increased their quota to 5 req/s,
you'd drop `minIntervalMs` to `220` and the system would get faster
proportionally — because the gate is the only thing throttling the agent loop.
If they tightened it to 1 per 10s, you'd have a problem: setting `minIntervalMs`
to 11000 would push a 6-call investigation to 66+ seconds before any retry,
already a big slice of the 300s route budget. That's the conversation the
comment at `connect.ts:86-93` is having with itself.

**What to read next.** `02-rate-limit-retry-ladder.md` covers the reactive
half of this story — when the proactive gate isn't enough, the retry ladder
recovers. `04-response-cache-with-no-cache-on-error.md` covers the cache that
lets the gate matter less for the common (repeat) path.

## Interview defense

**Q: Tell me about a rate-limiting decision you made.**

The agents call a third-party MCP server that rate-limits per-user globally at
about 1 req/s. We put a spacing gate in the data-source adapter with
`minIntervalMs = 1100` — 1.1s, not 1.0, the cushion absorbs clock skew. State
is one timestamp on the per-request adapter instance; before each live call we
compute `now - lastCallAt`, sleep the remainder if it's under threshold, then
update the timestamp *after* the call returns so a slow call widens the next
gap rather than letting calls bunch up.

The kernel is one timestamp + one threshold + one conditional sleep. What
breaks if I remove the timestamp: the second call goes out immediately, lands
inside the provider's penalty window, eats a 429, and the retry ladder pays
10-20s recovering. So the gate isn't optional decoration — it's the
proactive half of a "honor the quota or pay the retry" trade.

```
  Sketch on the whiteboard

  before each live call:
    elapsed = now - lastCallAt
    if elapsed < 1100:
       sleep(1100 - elapsed)
    transport.callTool(…)
    lastCallAt = now()           ← AFTER (slow calls widen spacing)
```

Anchor: `lib/data-source/bloomreach-data-source.ts:190-205`.

**Q: How is this different from backpressure?**

It's the question they answer that differs. The spacing gate answers "am I
exceeding a provider quota?" — driven by an internal clock against a known
external rate limit. Backpressure answers "is my consumer keeping up?" —
driven by a consumer-side signal like queue depth or lag. The two patterns
can look identical in code (one counter, one threshold, one conditional)
but they get tuned by different signals and fail in different ways: a wrong
spacing gate shows up as 429s from the provider; wrong backpressure shows up
as consumer OOMs or growing lag. In this codebase there's no consumer signal
to back-pressure against — the provider isn't a slow consumer, it's an
external authority with a quota. So calling it backpressure would have me
instrumenting queue depth when the real failure signal is 429 count.

```
  Sketch on the whiteboard

  spacing gate           backpressure
  ────────────           ────────────
  driver: clock          driver: consumer signal
  knob:   interval       knob:   queue cap / watermark
  fails:  429            fails:  OOM / lag
```

Anchor: the comment block at `lib/mcp/connect.ts:86-93` is where the design
trade is explicit.

**Q: Why 1100ms and not just 1000?**

The provider's stated window is "1 per 1 second" but `Date.now()` on our side
and the rate-limit window on their side aren't the same clock. A spacing of
exactly 1000ms means clock skew of even 50ms in the wrong direction puts two
calls inside the same penalty window. The 100ms cushion absorbs that skew.
It's the same instinct as setting a TCP keepalive a comfortable distance
below the LB idle timeout, not right against it.

**Q: What's the load-bearing part most people forget?**

That `lastCallAt` is updated **after** the call returns, not before it's sent.
Update it before, and a slow call lets the next call queue immediately — so
six calls submitted in a tight loop end up bursting at the provider when the
network catches up, even though their submission was nominally spaced. After,
and a slow call widens the gap to the next call, which is what you want
against a global-window quota.

## See also

- `02-rate-limit-retry-ladder.md` — the reactive half: when the gate isn't
  enough, the retry ladder honors the provider's stated wait.
- `03-per-call-timeout-ceiling.md` — the sibling ceiling: any single call
  can't exceed 30s, so the gate + retries together compose under a known cap.
- `04-response-cache-with-no-cache-on-error.md` — what makes the gate matter
  less for the common path (repeat reads inside 60s skip the gate entirely).
- `../study-runtime-systems/` — the `setTimeout`-as-sleep mechanism this gate
  rides on.
- `../study-distributed-systems/` — provider-quota semantics under partial
  failure (the "what if the provider changes the quota mid-request" question
  this gate intentionally doesn't try to answer).

# Partial Failure, Timeouts, and Retries

*Industry name: bounded retry with backoff · timeout composition · Type: Industry standard*

## Zoom out — where this concept lives

This is the load-bearing distributed-systems block in the repo. Every other file in this guide is either upstream (the map that says which arrow to defend) or downstream (the auth cookie that lets the retry ladder even reach the server). Here's where the correctness under partial failure actually lives:

```
  Zoom out — the retry + timeout stack

  ┌─ Client band ──────────────────────────────────────────┐
  │  browser · fetch('/api/agent') · req.signal            │
  └─────────────────────────┬──────────────────────────────┘
                            │  HTTPS
  ┌─ Server band ───────────▼──────────────────────────────┐
  │  route.ts   req.signal.throwIfAborted() at each phase  │
  │             │                                          │
  │             ▼                                          │
  │  ┌─ agent loop ─────────────────────────────────────┐  │
  │  │  dataSource.callTool(name, args, {signal})       │  │
  │  └───────────────────┬──────────────────────────────┘  │
  │                      │                                 │
  │  ┌─ McpDataSource ★ THIS FILE ★ ────────────────────┐  │
  │  │  · spacing gate: sleep(1100 - elapsed)           │  │
  │  │  · retry ladder: max 3, cap 20 s                 │  │
  │  │  · no-cache-on-error                             │  │
  │  └───────────────────┬──────────────────────────────┘  │
  │                      │                                 │
  │  ┌─ SdkTransport ───▼──────────────────────────────┐   │
  │  │  composeSignals(routeSig, timeout(30_000))      │   │
  │  │  → HTTP 0: timeout / HTTP 429 / HTTP 500 / …    │   │
  │  └──────────────────┬──────────────────────────────┘   │
  └─────────────────────┼───────────────────────────────────┘
                        │  HTTPS
                        ▼
                    ┌──────────┐
                    │MCP server│  ← the participant that can fail
                    └──────────┘
```

The whole stack collapses into one guarantee at the top: **every tool call either succeeds within some bounded time, or fails with a typed error that the caller can act on.** No infinite hangs, no silent drops.

## Zoom in — narrow to the concept

Partial failure is what makes distributed systems *distributed*. Your `fetch()` succeeded when you were in-process; the moment it crosses a network, any of these can happen:

- the request went out but the response never came back (timeout)
- the server got it, refused with 429, and told you when to try again
- the server threw 500 and told you nothing useful
- the response came back but the JSON is unclosed

Each one needs a different response. The concept this file walks is **the ladder**: what you do about each of those cases, in what order, with what bounds.

## Structure pass

The mechanism is a stack of independent moves. Reading the skeleton before the mechanics is the whole point.

### Layers

- **Route** (`app/api/agent/route.ts`) — owns the outer 300 s wall-clock and threads `req.signal` down. When the browser closes the tab, this signal fires.
- **Agent loop** (AptKit, in `node_modules`) — passes the signal down to each `callTool`. Doesn't retry itself.
- **McpDataSource** (`lib/data-source/bloomreach-data-source.ts`) — spacing gate + retry ladder + no-cache-on-error. This is the coordination brain.
- **Transport** (`lib/mcp/transport.ts`) — per-call `AbortSignal.timeout(30_000)` composed with the route signal. Timeout is a floor, not a ceiling.

### One axis held constant — "when does control return to the caller?"

```
  Axis: "when does control return with an outcome?"
        traced from outermost to innermost

  route         →   returns whenever agent loop returns,
                    bounded by req.signal or 300 s
                    → caller decides the outer bound

  agent loop    →   returns when the model says stop OR
                    when a tool call throws
                    → the agent doesn't set a timer

  McpDataSource →   returns after ≤ 3 retries × (up to 20 s wait) + call time
                    → this layer sets the retry ceiling

  SdkTransport  →   returns within 30 s per call (AbortSignal.timeout)
                    → this layer sets the per-call ceiling
```

The answer flips at every layer. That's the lesson: **no single layer knows the whole time budget.** Each layer bounds one thing, and the composition is the guarantee.

### Seams — where the axis flips

- **route ↔ agent loop**: the outer `req.signal` becomes the cancellation contract. `req.signal.throwIfAborted()` is called at each phase boundary (`route.ts:231`).
- **agent loop ↔ McpDataSource**: the abstract `signal` option on `DataSource.callTool` (`types.ts:39`). The agent loop passes it through; the adapter decides whether to add its own timeouts.
- **McpDataSource ↔ SdkTransport**: `composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS))` (`transport.ts:131`). This is where the per-call 30 s hard ceiling attaches. **First signal to fire wins.**

## How it works

### Move 1 — the mental model

You've written retry logic before, probably as `for (let i = 0; i < 3; i++) { try { … } catch { await sleep(1000 * 2**i); } }`. This is that same skeleton, hardened for one participant with known behavior. Two hardenings matter: **honor the server's stated window** (not blind backoff), and **compose your timeout with the client's cancel** (not a lone timer).

```
  The pattern — the retry ladder as a state machine

    start
      │
      ▼
   ┌─────────────┐
   │ spacing gate│  ← wait 1100 - elapsed ms
   └──────┬──────┘
          │
          ▼
   ┌─────────────┐
   │ liveCall    │  ← AbortSignal.timeout(30_000) inside
   └──────┬──────┘
          │
          ▼
     ┌────┴────┐
     │ result? │
     └────┬────┘
     ok?  │  rate-limited?          error?
     yes ─┤  yes ↓                  throws
          │  ┌──────────────┐       ↑
          │  │ parse retry- │       │
          │  │ after hint   │       │
          │  └──────┬───────┘       │
          │         │               │
          │         ▼               │
          │  ┌──────────────┐       │
          │  │ sleep(min(   │       │
          │  │  hint,       │       │
          │  │  ceiling))   │       │
          │  └──────┬───────┘       │
          │         │               │
          │         └───► retry ────┘
          │             (max 3)
          ▼
     cache? no if error
     return {result, durationMs, fromCache}
```

The kernel: **spacing gate + timed call + bounded retry that honors the server's window**. Strip any of these and something breaks (see the load-bearing skeleton below).

### Move 2 — the walkthrough

Walk it one moving part at a time. Each part is a sub-heading; each part gets a diagram.

#### The spacing gate — proactive rate limiting

Bloomreach's rate limit is *per user, global* — 1 req/second, with the window stated in the error text ("1 per 10 second"). Reactively hitting the limit and backing off costs you a real 10 s wait plus a wasted round-trip. Proactively spacing calls at ~1.1 s means you rarely hit the limit at all.

```
  Spacing gate — the sleep before every liveCall

  callTool #1:  elapsed=0        no wait      lastCallAt = now
                                 fires

  callTool #2:  elapsed=200ms    sleep 900ms  lastCallAt = now
                                 fires

  callTool #3:  elapsed=2000ms   no wait      lastCallAt = now
                                 fires
                                 (already past minInterval)
```

Here's the code, verbatim, from `lib/data-source/bloomreach-data-source.ts:190`:

```ts
// lib/data-source/bloomreach-data-source.ts:190
private async liveCall(name, args, signal?): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {                                // ← 1100 ms
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  try {
    const result = await this.transport.callTool(name, args, { signal });
    this.lastCallAt = Date.now();                                    // ← success updates
    return result;
  } catch (err) {
    this.lastCallAt = Date.now();                                    // ← so does failure
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}
```

Two design decisions worth naming:

- The gate updates `lastCallAt` **on both success and failure** (lines 197, 200). If it only updated on success, a burst of errors would burn straight through the gate.
- The default `minIntervalMs = 1100` (constructor default 200, overridden to 1100 at `connect.ts:121`). The 1.1 s picks a value just above the 1 req/s window — enough headroom for clock jitter without eating into the 60 s route budget.

**Failure mode this fixes**: without the gate, six rapid calls to Bloomreach return 429 six times, each triggering a ~10 s retry wait — that's a full minute burned on one investigation. The gate keeps calls under the window in the first place.

#### The retry ladder — reactive rate limiting

The gate is proactive; the ladder is what happens when Bloomreach 429s anyway (because two Vercel instances share one Bloomreach account — the gate is per-instance).

```
  Retry ladder — respect the server's stated window

  call → result   is result a 429? ──no──► return

                       │
                      yes
                       ▼
              parse retry-after hint
              from the error text
                       │
              hint = null? ── yes ──► backoff = 10s × 2^(retries-1)
                       │
                      no                          │
                       ▼                          │
              wait = hint + 500ms buffer          │
                       │                          │
                       └──► min(wait, 20_000ms) ──┘
                                     │
                                     ▼
                                  sleep, retry
                                  (max 3 attempts)
```

Code side by side (`bloomreach-data-source.ts:157`):

```ts
// lib/data-source/bloomreach-data-source.ts:157
let retries = 0;
while (isRateLimited(result) && retries < this.maxRetries) {
  retries++;
  const hintMs = parseRetryAfterMs(result);                         // ← parses "1 per 10 second"
  const backoffMs = this.retryDelayMs * 2 ** (retries - 1);         // ← fallback exponential
  const waitMs = Math.min(
    hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,          // ← +500 ms cushion
    this.retryCeilingMs,                                            // ← 20_000 ms ceiling
  );
  await sleep(waitMs);
  result = await this.liveCall(name, args, options.signal);
}
```

Read line by line:

- Line 3 `retries < this.maxRetries` — bounded. Max 3 total attempts (config from `connect.ts:124`).
- Line 4 `parseRetryAfterMs(result)` — reads the server's stated penalty window. Two shapes are supported: `"retry-after 12 seconds"` and `"1 per 10 second"` (`bloomreach-data-source.ts:64`).
- Line 5 `backoffMs` — if the hint is unparseable, fall back to exponential (10 s, 20 s, 40 s at defaults).
- Line 6-9 `Math.min(hint + buffer, ceiling)` — the ceiling caps the wait at 20 s. Without it, a parsed 60 s window would blow the 60 s route budget on one call.
- Line 10 `sleep(waitMs)` — synchronous wait. The route's cancel signal is NOT respected inside this sleep, which is a known gap; the next `liveCall` sees it.

**Failure mode this fixes**: without the parsed hint, blind backoff at 1 s / 2 s / 4 s would burn 3 attempts against a 10 s window and fail all three. The parsed hint means the *first* retry lands just after the window clears.

#### The per-call 30 s timeout — the floor

Every tool call has a hard ceiling composed at the transport layer:

```ts
// lib/mcp/transport.ts:131
async callTool(name, args, opts?): Promise<unknown> {
  if (this.httpErrors) this.httpErrors.last = null;
  const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));  // ← 30_000
  try {
    return await this.client.callTool({ name, arguments: args }, undefined, { signal });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`HTTP 0: timeout after ${TOOL_TIMEOUT_MS}ms`, { cause: err });   // ← typed
    }
    …
  }
}
```

The interesting move is `composeSignals(routeSig, AbortSignal.timeout(30_000))` — first signal to fire wins. If the browser closes the tab, `routeSig` fires and cancels the in-flight fetch immediately. If Bloomreach hangs, the timeout fires at 30 s and produces a typed `HTTP 0: timeout` error.

```
  composeSignals — OR of any-fires-cancels

  routeSig ────────abort────────►┐
                                 │
                                 ├──► composed signal
                                 │    fires on FIRST
                                 │    of either source
  AbortSignal.timeout(30_000) ──►┘

  → uses AbortSignal.any([...]) when available (Node 20+)
  → fallback manual glue otherwise (transport.ts:180)
```

**Failure mode this fixes**: without the per-call timeout, a hung TCP connection to Bloomreach would burn the entire 300 s route budget on ONE call, and the user sees a spinner for five minutes. With it, a hung call fails at 30 s, the model sees `HTTP 0: timeout`, and the agent decides what to do next (usually: try a different tool).

**Why not retry timeouts inside the ladder?** Deliberately: the retry ladder only retries *successful-but-rate-limited* results (`isRateLimited(result)` at line 164, not thrown errors). A 30 s timeout retried 3 times = 90 s guaranteed, half the route budget on one dead call. Better to fail fast and let the model decide.

#### no-cache-on-error — the correctness knob

If the tool call succeeds but returns `isError: true` (a Bloomreach validation error, a permissions error, a rate-limited-and-exhausted-retries envelope), the cache doesn't take it:

```ts
// lib/data-source/bloomreach-data-source.ts:178
// Don't cache error results — they should not poison the cache.
if ((result as any)?.isError === true) {
  return { result: result as T, durationMs, fromCache: false };
}
// ... only NON-error results reach the cache.set() below
this.cache.set(cacheKey, { result, expiresAt: now + ttl });
```

This is a **circuit-breaker-adjacent** decision, not a full breaker. A real breaker tracks failure rate and opens after a threshold. This just refuses to cache errors, so the next identical call actually re-tries the server instead of returning a stale error for 60 s.

```
  Cache decision table

  result state       │ cached? │ next call same args
  ───────────────────┼─────────┼───────────────────────
  ok                 │  yes    │  cache hit (60 s TTL)
  rate-limited       │  no*    │  hits server, retry ladder runs
  isError:true       │  no     │  hits server, may succeed this time
  throws (timeout)   │  no     │  propagates; caller sees typed error

  * ladder retries first; only the FINAL result is subject to caching
```

**Failure mode this fixes**: without no-cache-on-error, a transient permissions blip would cache "you can't read this event" for 60 s. Every retry from the model would return the stale error instantly, and the investigation stalls without an obvious cause.

### Move 2 variant — the load-bearing skeleton

Strip everything down to what MUST be present for this pattern to still be itself:

```
  Kernel:
    1. spacing gate (proactive rate limit)
    2. bounded call with a per-call timeout
    3. bounded retry with server-stated window
    4. no-cache-on-error

  What breaks if you remove each:

    1. Drop the gate           → 429 storm; each retry costs 10 s;
                                  investigation blows the 60 s budget
    2. Drop the per-call cap   → one hung TCP burns 300 s; user
                                  stares at a spinner for 5 min
    3. Drop the retry ladder   → any transient 429 is a hard failure;
                                  the tool result gets `isError: true`
                                  and the model has to reason around it
    4. Drop no-cache-on-error  → transient errors cached for 60 s;
                                  stale error returned to every retry
```

**Hardening layered on top** (not the kernel):
- FaultInjectingDataSource decorator — offline chaos testing, not required for correctness.
- Response cache (60 s TTL) — an optimization that reduces load; the kernel works without it.
- `RETRY_BUFFER_MS = 500` — a cushion, not load-bearing.
- Exponential fallback when the hint is unparseable — hardening; the parsed hint is the load-bearing case.

The interview payoff is naming what people forget: **the spacing gate updates `lastCallAt` on failure too.** Without that one line, a burst of errors defeats the gate entirely.

### Move 3 — the principle

**Bound every wait, at every layer, with a signal that composes upward.** A retry loop with no per-call timeout is a hang waiting to happen. A per-call timeout with no client-cancel composition ignores the user closing the tab. A retry ladder that doesn't respect the server's stated window is guessing. This repo's stack shows the composition: `req.signal → agent.callTool.signal → composeSignals → AbortSignal.timeout(30_000)`. Every layer bounds one thing; the whole thing is bounded because they compose.

## Primary diagram

Everything Move 2 walked, one frame:

```
  The full retry + timeout stack, one investigation

  browser closes tab
       │
       ▼ req.signal aborts
  ┌──────────────────────────────────────────────────┐
  │ app/api/agent/route.ts   maxDuration=300s         │
  │  · req.signal.throwIfAborted() at each phase      │
  │  · finally block records phases even on throw     │
  └───────────────────────────┬──────────────────────┘
                              │ signal
                              ▼
  ┌──────────────────────────────────────────────────┐
  │ AptKit agent loop                                 │
  │  · passes signal to every callTool                │
  │  · does NOT retry at invocation level             │
  └───────────────────────────┬──────────────────────┘
                              │ signal
                              ▼
  ┌──────────────────────────────────────────────────┐
  │ McpDataSource.callTool   ★ retry ladder here ★    │
  │                                                   │
  │  cache hit?  yes ──► return {fromCache: true}     │
  │  no  ↓                                            │
  │  spacing gate: sleep(1100 - elapsed)              │
  │  result = liveCall(...)                           │
  │                                                   │
  │  while (isRateLimited(result) && retries < 3):    │
  │    hint = parseRetryAfterMs(result)               │
  │    wait = min(hint + 500 || 10s × 2^n, 20_000)    │
  │    sleep(wait); result = liveCall(...)            │
  │                                                   │
  │  isError? yes ──► skip cache; return              │
  │  no       ──► cache 60 s; return                  │
  └───────────────────────────┬──────────────────────┘
                              │ signal
                              ▼
  ┌──────────────────────────────────────────────────┐
  │ SdkTransport.callTool   ★ per-call timeout here ★ │
  │                                                   │
  │  signal = composeSignals(routeSig, timeout(30s))  │
  │  try: return await client.callTool(...)           │
  │  catch:                                           │
  │    timeout ──► throw `HTTP 0: timeout after 30s`  │
  │    HTTP    ──► throw `HTTP {status}: {body}`      │
  │    (body redacted for secrets first)              │
  └───────────────────────────┬──────────────────────┘
                              │  HTTPS
                              ▼
                     ┌─────────────────┐
                     │  MCP server     │
                     └─────────────────┘
```

## Elaborate

The literature calls this pattern **bounded retry with backoff** (Jitter is best-practice; this repo doesn't add jitter because the retries are already gated by the server's stated window, so jitter would slightly *hurt* by desyncing from the window). The AbortSignal composition is a lift of the newer web-platform pattern (`AbortSignal.any`, Node 20+, Chrome 116+) — before that landed, everyone rolled their own OR-glue. The transport keeps the fallback (`transport.ts:180`) for belt-and-braces.

The circuit-breaker literature would want more than no-cache-on-error: track failure rate per-endpoint, open the breaker after a threshold, return fast-fails while it's open, half-open probes to close it. This repo doesn't need that yet because there's ONE endpoint and the retry ladder already bounds the exposure. If a second MCP server came online, or if Bloomreach outages became common, that's when a real breaker earns its complexity budget.

**Phase-4 fault injection** turns this ladder into a test surface. The decorator forces `HTTP 0`, `429`, `500`, or malformed JSON at configurable rates (`fault-injecting.ts:65`). The receipt: 9 injected faults across 3 investigations, zero investigations failed. That's the ladder holding: the retries absorbed the 429s, the model reasoned around the timeouts (they surface as `is_error: true` on tool results), and the malformed JSON was rejected downstream by the schema guard.

Related reading: `03-idempotency-deduplication-and-delivery-semantics.md` — this ladder makes retries safe only because the tool calls are read-only. The moment a tool has a side effect, the ladder needs an idempotency key.

## Interview defense

**Q: "Walk me through what happens when the MCP server returns a 429."**

A: The response comes back with `isError: true` and rate-limit text in the content. `isRateLimited(result)` returns true. The ladder parses the stated window from the text — either `"retry-after 12 seconds"` or `"1 per 10 second"` — adds a 500 ms buffer, caps at 20 s, sleeps, and re-fires the call. Up to 3 retries. If they all 429, the final result comes back with `isError: true` and the model sees it as a tool_result with `is_error: true`.

```
   [call] → 429 (1 per 10s) → sleep 10.5 s → [call] → ok
                                    │
                              (parsed hint,
                              not blind backoff)
```

**Anchor**: `lib/data-source/bloomreach-data-source.ts:157` — the ladder.

**Q: "Why 30 seconds for the per-call timeout, and why don't you retry timeouts?"**

A: 30 s is a floor: any single MCP call that takes longer than 30 s is dead — the SDK doesn't stream, so a slow call is a stuck call. Retrying timeouts is a trap because three retries × 30 s = 90 s guaranteed against a 300 s route budget, on ONE dead call. Better to fail fast with `HTTP 0: timeout` and let the model reason around it — usually by picking a different tool. The retry ladder only retries *successful-but-rate-limited* results, not thrown errors.

**Load-bearing gotcha**: `composeSignals(routeSig, AbortSignal.timeout(30_000))` — the OR-composition means the browser closing the tab cancels the in-flight MCP call immediately, not at the next 30 s boundary. Without the compose, the timeout would eat the cancel.

**Q: "What happens if the server returns an isError result — do you cache it?"**

A: No. `bloomreach-data-source.ts:178` — the cache write is gated on `!result.isError`. If we cached errors, a transient permissions blip would poison the cache for 60 s and every retry from the model would return the stale error instantly. That's a "circuit-breaker-adjacent" decision — not a full breaker, but the same instinct: don't propagate a bad state as if it were good.

## See also

- `01-distributed-system-map.md` — the map that says which arrow this ladder defends.
- `03-idempotency-deduplication-and-delivery-semantics.md` — why retries are safe here (read-only tools).
- `04-consistency-models-and-staleness.md` — the cache TTL, which the ladder's no-cache-on-error interacts with.
- `09-distributed-systems-red-flags-audit.md` — what this ladder doesn't defend against.

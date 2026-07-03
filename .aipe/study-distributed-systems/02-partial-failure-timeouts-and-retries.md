# partial-failure-timeouts-and-retries

*Timeout composition · Retry ladder · Circuit-breaker-adjacent · Fault injection · Industry standard*

## Zoom out — where this concept lives

Partial failure is the whole point of distributed systems. This is the file
where the actual mechanisms live — timeout composition, the retry ladder,
the no-cache-on-error rule, and the fault-injection subsystem that lets you
prove they work without waiting for Bloomreach to actually break.

```
  Zoom out — partial-failure mechanisms in the service layer

  ┌─ Client layer ────────────────────────────────────┐
  │  fetch(...) — sees NDJSON `{type:"error"}` or     │
  │  a truncated stream on total collapse             │
  └───────────────────┬───────────────────────────────┘
                      │
  ┌─ Service layer ───▼───────────────────────────────┐
  │  ★ WHERE PARTIAL-FAILURE MECHANISMS LIVE ★         │ ← we are here
  │                                                    │
  │  ┌─ FaultInjectingDataSource ─┐  (offline chaos)   │
  │  ├─ BloomreachDataSource      │                    │
  │  │  · minIntervalMs spacing   │                    │
  │  │  · retry ladder (parsed)   │                    │
  │  │  · no-cache-on-error       │                    │
  │  └─ SdkTransport ──────────────┘                   │
  │     · composeSignals(30s + req.signal)             │
  │                                                    │
  │  AptKit agent loop                                 │
  │     · catches throws → tool_result is_error:true   │
  │     · model reasons about failed call              │
  └────────────────────┬───────────────────────────────┘
                       │  hop B (Bloomreach)
                       ▼
  ┌─ Provider layer ────────────────────────────────────┐
  │  loomi-mcp-alpha — the thing that fails             │
  └─────────────────────────────────────────────────────┘
```

Every mechanism is inside the service layer. Some of them (timeout,
spacing) fire on the OUTBOUND leg to Bloomreach; the retry ladder
fires on the INBOUND result; graceful degradation fires when neither
of the first two saved you.

## Structure pass

### Layers of defense — four bands

```
  Four bands, outermost to innermost — what fires first, then next

  ┌─ 1. Proactive spacing  (minIntervalMs=1100) ────────────┐
  │   Fires BEFORE the call. Belts.                          │
  └──────────────────────────┬───────────────────────────────┘
                             │
  ┌─ 2. Per-call timeout  (AbortSignal.timeout=30_000) ─────┐
  │   Fires DURING the call. Bounds any single call.         │
  └──────────────────────────┬───────────────────────────────┘
                             │
  ┌─ 3. Retry ladder  (parse server hint, cap 20s, max 3) ──┐
  │   Fires AFTER the call, if isError && rate-limited.      │
  └──────────────────────────┬───────────────────────────────┘
                             │
  ┌─ 4. Graceful degradation  (tool_result is_error:true) ──┐
  │   Fires AFTER all above give up. Model reasons about it. │
  └──────────────────────────────────────────────────────────┘
```

### One axis — trace "who catches this failure?"

```
  "who catches this failure?" — held constant across layers

  ┌───────────────────────────────────────────────┐
  │ transport layer (SdkTransport)                 │
  │   catches: AbortError, TimeoutError, HTTP N    │ ← reshapes into
  │   catches at lib/mcp/transport.ts:134           │   `HTTP 0:...` throw
  └───────────────────────────────────────────────┘
      ┌───────────────────────────────────────────────┐
      │ adapter layer (BloomreachDataSource)          │
      │   catches: everything above → McpToolError    │ ← tags with tool name
      │   catches at bloomreach-data-source.ts:199    │   re-throws
      └───────────────────────────────────────────────┘
          ┌────────────────────────────────────────────────┐
          │ agent loop (AptKit run-agent-loop.js)          │
          │   catches: every throw → tool_result is_error  │ ← LOAD-BEARING
          │   catches at run-agent-loop.js:81-86           │   SILENT SAVE
          └────────────────────────────────────────────────┘
              ┌──────────────────────────────────────────┐
              │ route handler (/api/agent)               │
              │   catches: BudgetExceeded, AbortError    │
              │   catches at route.ts:303-316            │
              └──────────────────────────────────────────┘
```

The answer flips at every layer. And the answer at the third layer — the
agent loop — is the one that matters most, because it turns "this call
threw" into "the model can reason about it and decide what to do next."

### Seams

- **`opts.signal` seam** — `SdkTransport.callTool` composes it with the
  30s timeout via `composeSignals` at `lib/mcp/transport.ts:131`. This is
  where "cancellable" becomes "always bounded."
- **`isRateLimited(result)` seam** — the retry ladder is guarded by this
  predicate at `bloomreach-data-source.ts:164`. It reads the result text
  for `/rate limit|too many requests/i`. If the shape of Bloomreach's
  error envelope changes, this predicate is the single point of failure.
- **`fromCache: boolean` seam** — every DataSource result carries whether
  it hit cache. The route hooks read this and surface it in the UI's
  "how it was gathered" panel. Downstream code doesn't distinguish
  fresh from cached, which is correct — but the surface is honest.

## How it works

### Move 1 — the mental model: four bands, first-fires-wins

You know how a `try { fetch(...) } catch (e) { retry() }` looks in one
function? Take that shape and split it across four layers, each with a
different concern:

```
  The pattern — a call passing through four defenses

    request ──► [ 1. spacing ] ──► [ 2. per-call timeout ] ──► [ Bloomreach ]
                                                                    │
                                                                    ▼
    response ◄─ [ 4. graceful ] ◄─ [ 3. retry-on-429 ] ◄─────── result / err

           each defense has ONE job:
           1. prevent 429s   (spacing)
           2. bound duration (timeout)
           3. absorb 429s    (retry)
           4. survive rest   (tool_result is_error)
```

Band 1 fires optimistically (before you know you'd 429). Band 2 fires
protectively (bounds any single call). Band 3 fires reactively (parse the
server's hint, wait, retry). Band 4 fires when all three above give up.

### Move 2 — walk the mechanism one band at a time

#### Band 1 — the proactive spacing gate

The Bloomreach alpha rate-limits per-user globally. If you send back-to-back
calls, the second one gets a 429. Instead of eating that 429 every time,
`BloomreachDataSource` remembers when its last call finished and sleeps
before the next one:

```typescript
// lib/data-source/bloomreach-data-source.ts:190-197 — liveCall spacing
private async liveCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  // ... transport.callTool
  this.lastCallAt = Date.now();
```

Bridge from what you know: this is a client-side "leaky bucket" of size 1.
You've seen this shape when a UI debounces button clicks — same primitive,
different failure mode being defended against.

**Load-bearing part: `this.lastCallAt = Date.now()` in BOTH branches
(`:197` on success, `:200` on error).** Skip the error-branch update and a
failed call doesn't reset the spacing clock, so the retry lands inside the
window it was supposed to space out. This is the boundary condition —
easy to miss because the "happy path" version works fine in tests.

Why `1100` and not `10000` (the observed pessimistic window)? At the
pessimistic window a 6-call investigation costs 60s just in spacing,
blowing the 60s Hobby-tier budget. `connectMcp` documents this trade
explicitly at `lib/mcp/connect.ts:87-93`:

> Proactive spacing stays at ~1.1s on purpose: spacing at the full 10s
> window would cost ~60s for a 6-call investigation and blow the route's
> 60s budget (app/api/agent). Instead, BloomreachDataSource parses the
> stated window from each 429 and waits it out on retry.

The trade: pay the 429 penalty when it fires (via band 3), don't pay it
preemptively (via band 1).

#### Band 2 — the per-call timeout, composed with cancellation

Every MCP call is bounded by a 30s ceiling. If it takes longer, the signal
fires and the call aborts:

```typescript
// lib/mcp/transport.ts:131-137 — the composition
async callTool(name: string, args: Record<string, unknown>, opts?: CallToolOpts): Promise<unknown> {
  if (this.httpErrors) this.httpErrors.last = null;
  const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
  try {
    return await this.client.callTool({ name, arguments: args }, undefined, { signal });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`HTTP 0: timeout after ${TOOL_TIMEOUT_MS}ms`, { cause: err });
    }
```

Two signals in, one signal out — whichever fires first wins:

```
  Signal composition — first-fires-wins

     req.signal              AbortSignal.timeout(30_000)
     (client cancelled)      (per-call ceiling)
           │                          │
           └────────┬─────────────────┘
                    ▼
              composeSignals(...)   ← lib/mcp/transport.ts:173
                    │                 uses AbortSignal.any() on Node 20+
                    ▼
              single AbortSignal
                    │
                    ▼
         client.callTool({ signal })

  fires when: client aborted OR 30 seconds elapsed OR both
```

**Load-bearing part: `AbortSignal.any([...])` at
`lib/mcp/transport.ts:177-178`.** The manual `AbortController` fallback
below it is belt-and-braces for older runtimes — on modern Node it never
runs. If `AbortSignal.any` weren't available and the fallback also
misfired, a client-cancelled request could keep burning 30s waiting for
the timeout because nothing forwarded the abort.

**Why re-throw as `HTTP 0: timeout after 30000ms` and not the original
`AbortError`?** Because downstream callers pattern-match on `HTTP N:`
prefixes to identify failure classes. `HTTP 0` is a distinct tag callers
recognize as timeout-vs-transport-error-vs-server-error. Look at the
fault injector at `lib/data-source/fault-injecting.ts:115`:

```typescript
// mimics the real transport's timeout shape exactly
throw new Error(`HTTP 0: timeout after 30000ms`, {
  cause: new Error('injected fault: timeout'),
});
```

The fault injector reproduces the transport's error shape so downstream
handlers can't tell an injected timeout from a real one. That's the point.

#### Band 3 — the retry ladder, parsed from the server's error text

This is where the interesting distributed-systems reading happens: the
server tells you how long to wait, and you honor it. Bloomreach's 429
envelopes have been observed in two shapes:

```
  "Retry after ~12 second(s)"           → parseRetryAfterMs → 12_000
  "rate limit reached (1 per 10 second)" → parseRetryAfterMs → 10_000
```

The parser at `bloomreach-data-source.ts:64-71`:

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

Two shapes, two regexes. Neither matches → fall back to backoff (`retryDelayMs`).

The ladder itself at `bloomreach-data-source.ts:163-174`:

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

Trace the execution for a rate-limited call:

```
  Execution trace — retry ladder for a 429 result

  state before          retries  hintMs  backoffMs  waitMs (min of hint+500 or backoff, capped 20_000)
  ─────────────────     ───────  ──────  ─────────  ──────
  result = 429 ("per 10 second")   0     10_000    —         (loop entry)
    → retries=1, hint=10_000, waitMs=min(10_500, 20_000)=10_500 → sleep, retry
  result = 429 (still)              1     10_000    20_000    (retryDelayMs * 2^0 = 10_000; but we prefer hint)
    → retries=2, waitMs=min(10_500, 20_000)=10_500 → sleep, retry
  result = 429 (still)              2     10_000    —
    → retries=3, waitMs=10_500 → sleep, retry
  result = 429 (still)              3     —         —         (retries == maxRetries, exit loop)
    → return result (isError=true) to caller UNCACHED
```

**Load-bearing part: the `+ RETRY_BUFFER_MS` cushion at
`bloomreach-data-source.ts:169` (RETRY_BUFFER_MS = 500 at `:49`).**

Retrying exactly on the boundary of the server's stated window lands
inside the window and burns another attempt. The 500ms buffer lands the
retry just AFTER the penalty clears. Skip it and every retry costs an
attempt for nothing.

**Also load-bearing: the retry ladder ONLY retries `isError && rateLimited`
results.** Timeouts throw (band 2's `HTTP 0`), and the ladder only sees
returned envelopes. This is deliberate — as the transport comment at
`lib/mcp/transport.ts:34-37` says:

> The retry ladder in McpClient.callTool only retries successful-but-rate-
> limited results, so the timeout error fails fast — exactly what we want,
> since a retry would just risk another 30s wait inside the same route
> budget.

#### Band 4 — graceful degradation via `tool_result` `is_error: true`

This is the load-bearing find of the whole file. When all three defenses
above give up, the AptKit agent loop catches the throw and hands the model
a `tool_result` block with `is_error: true` — and the model reasons about
it and decides whether to retry or move on.

```javascript
// node_modules/@aptkit/core/node_modules/@aptkit/runtime/dist/src/run-agent-loop.js:73-102
let isError = false;
let resultContent;
try {
  const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
  toolCall.result = result;
  toolCall.durationMs = durationMs;
  resultContent = truncate(JSON.stringify(result));
}
catch (error) {
  isError = true;
  const message = error instanceof Error ? error.message : String(error);
  toolCall.error = message;
  resultContent = truncate(JSON.stringify({ error: message }));
}
// ...
toolResults.push({
  type: 'tool_result',
  toolUseId: toolUse.id,
  content: resultContent,
  ...(isError ? { isError: true } : {}),
});
```

The catch at line 81 is the whole thing. The throw doesn't propagate; the
model gets a `tool_result` back with `isError: true` and can:

- **retry** — call the same tool again with the same or different args
- **try a different tool** — reach for a fallback
- **conclude without it** — write a diagnosis based on what it does have
- **give up** — emit a final text response saying it couldn't proceed

Which one it picks is determined by the system prompt, the failure
message, and the model's own reasoning. **You do not write control flow
for this.**

The receipt from the Week 4B smoke test:

```json
// eval/load-receipts/load-2026-07-03T05-21-12-237Z.json (excerpt)
{
  "config": { "N": 3, "faultRates": { "timeout": 0.2, "malformedJson": 0.2 }, "faultSeed": 42 },
  "succeeded": 3,
  "failed": 0,
  "faultTotals": { "malformed_json": 5, "timeout": 4 }
}
```

Nine faults across three investigations. Zero failures. **The model
absorbed the injected failures the same way it absorbs real ones.**

### The skeleton — what breaks when a band is missing

Isolate the kernel. The pattern is: "a call passes through four
defensive bands, and if any band fires it produces a specific side
effect the next band can consume." What breaks without each part:

- **Drop band 1 (spacing)** — every call hits the alpha's 1 req/s ceiling
  and 429s. Band 3 fires on every single call. Investigation latency
  triples (each call costs ~10s of retry wait). Never breaks
  correctness; kills the budget.
- **Drop band 2 (timeout)** — a hung call at the alpha ties up the
  entire 300s route. One user's stuck request denies the warm instance
  to every other user until Vercel kills the function. Breaks
  correctness (denial-of-availability).
- **Drop band 3 (retry ladder)** — every rate-limit error propagates
  as a tool failure. Band 4 fires more often; the model gives up on
  more investigations. Doesn't break correctness (model can still
  reason), degrades quality.
- **Drop band 4 (agent-loop catch)** — every failure throws out of
  the agent, up through the route, and lands on the client as
  `{type: "error"}`. The whole investigation fails on one bad tool
  call. Breaks the "analyst that shows its work" pitch entirely.

Band 4 is the LOAD-BEARING one. Everyone talks about retry logic; the
part they forget is that the model itself is the recovery mechanism, and
it only works because the runtime catches the throw. Look at that
one try/catch in a library you don't own — that's the safety net.

### Optional hardening layered on top

- **The 60s cache** at `bloomreach-data-source.ts:147-152` — absorbs
  repeats of successful calls. Not defense against failure; defense
  against latency. Skips the whole four-band stack when it hits.
- **`no-cache-on-error`** at `:179-181` — the caching's failure sibling.
  Error envelopes are returned but not cached, so a transient 401 doesn't
  poison a minute of subsequent calls. This is circuit-breaker-adjacent
  — it doesn't close the circuit, but it doesn't let a bad state
  memoize either.
- **`skipCache: true`** at `:147` — the `/debug` panel's "force fresh"
  path. Bypasses the cache but still writes on success (write-through).

### Move 3 — the principle

**A single external system with real partial failure teaches you
distributed systems better than five services with none.** The
temptation is to build the elaborate machinery because "that's what
distributed systems look like." The lesson from this repo: the retry
ladder that parses the server's own error text is worth more than a
generic exponential backoff, and the graceful-degradation-via-tool-result
mechanism is worth more than any circuit breaker you'd build by hand.
The mechanism sits at the RIGHT layer for the failure: at the transport
for shape, at the adapter for retry, at the agent loop for reasoning.

## Primary diagram — recap

```
  One call, four bands, first-fires-wins

  agent → dataSource.callTool('execute_analytics_eql', { eql }, { signal: req.signal })
                                    │
                                    ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ BAND 0: cache check (60s, name+args key)                            │
   │   HIT → return { result, durationMs: 0, fromCache: true }           │
   │   MISS → continue                                                   │
   └───────────────────────────┬─────────────────────────────────────────┘
                               ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ BAND 1: proactive spacing (minIntervalMs=1100)                      │
   │   elapsed = Date.now() - lastCallAt                                 │
   │   if elapsed < 1100: sleep(1100 - elapsed)                          │
   └───────────────────────────┬─────────────────────────────────────────┘
                               ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ BAND 2: per-call timeout (AbortSignal.timeout=30_000)               │
   │   signal = composeSignals(req.signal, timeout(30_000))              │
   │   try { client.callTool(..., { signal }) }                          │
   │   catch AbortError|TimeoutError → throw `HTTP 0: timeout after 30s` │
   │   catch other → throw `HTTP N: <server body>`                       │
   └───────────────────────────┬─────────────────────────────────────────┘
                               ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ BAND 3: retry ladder (maxRetries=3, ceiling=20s, buffer=500ms)      │
   │   while isRateLimited(result) && retries < 3:                       │
   │     retries++                                                        │
   │     waitMs = min(hint + 500 OR retryDelayMs * 2^(retries-1), 20_000)│
   │     sleep(waitMs); retry                                             │
   └───────────────────────────┬─────────────────────────────────────────┘
                               ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ CACHE WRITE-THROUGH: only if !isError                               │
   │   isError → return uncached (no poison)                             │
   │   !isError → cache.set(key, { result, expiresAt: now + 60_000 })    │
   └───────────────────────────┬─────────────────────────────────────────┘
                               ▼
                    { result, durationMs, fromCache: false }
                                        │
                                        ▼
                           ┌─ throws propagate here ─┐
                           │   AptKit agent loop     │
                           │   catches at :81, wraps │
                           │   as tool_result        │
                           │   { is_error: true }    │
                           │   → BAND 4: model       │
                           │     reasons about it    │
                           └─────────────────────────┘
```

## Elaborate

The four-band pattern is a canonical shape in production
service-to-service calls. The specific names vary — "resilience patterns"
in .NET's Polly library, "resilience4j" in JVM, "hystrix" historically
(circuit-breaker origin), Netflix's `Bulkhead` — but the shape is the
same: proactive rate control, per-call bounding, retry-with-parsed-hint,
graceful degradation.

What this repo doesn't have that a larger system would:

- **Circuit breaker with state machine** (closed/open/half-open) — the
  no-cache-on-error rule is a small piece of this but not the whole
  machine. A real circuit breaker counts failures and opens the circuit
  after a threshold, refusing calls without even trying. Not needed here
  because there's ONE upstream and ONE consumer per session — the
  humans provide the "stop trying" signal by not clicking.
- **Bulkhead pattern** (thread pool isolation) — Node's single event
  loop makes this less relevant, but a real production system with
  multiple upstreams would want per-upstream concurrency limits so a
  slow one can't starve a fast one.
- **Retry budget** across an investigation — right now `maxRetries=3` is
  per-call; a single investigation can burn 6 × 3 = 18 total retries.
  Not a problem at current scale.

The fault-injection subsystem at `lib/data-source/fault-injecting.ts`
turns this from "we think it works" into "we've measured it working."
That receipt at `eval/load-receipts/load-2026-07-03T05-21-12-237Z.json`
is the artifact — reproducible via `FAULT_SEED=42`, so a regression is
detectable.

## Interview defense

### Q: "How does the app survive when Bloomreach times out?"

Sketch this as you speak:

```
  4 bands, ranked from cheapest to most-drastic

  spacing (1100ms) → timeout (30s) → retry (parse hint, cap 20s)
                                              │
                                              ▼
                          agent loop catches → tool_result is_error:true
                                              │
                                              ▼
                          model reasons: retry / try different tool / conclude
```

"Four layers of defense. Proactive spacing at 1100ms prevents most 429s.
The 30s per-call timeout bounds any single stuck call. If Bloomreach
returns a rate-limit envelope, the retry ladder parses the stated
window from the error text (`Retry after ~N second(s)`) and waits it
out, capped at 20s per attempt, max 3 attempts. If all of that gives up,
AptKit's agent loop catches the throw and hands the model a
`tool_result` block with `is_error: true` — the model then reasons
about the failed call and decides whether to retry, try a different
tool, or write the diagnosis without it. That last part is the
load-bearing one: **there is no invocation-level catch-and-retry
anywhere in our code**. The model is the recovery mechanism."

Anchors: `lib/data-source/bloomreach-data-source.ts:190-197` (spacing),
`lib/mcp/transport.ts:131-137` (timeout composition),
`bloomreach-data-source.ts:163-174` (retry ladder), AptKit
`run-agent-loop.js:81-86` (the catch).

### Q: "What's the part everyone forgets?"

"The `+ RETRY_BUFFER_MS` cushion. Retrying exactly on the server's
stated window lands inside the window and burns another attempt. It's
500ms at `bloomreach-data-source.ts:169`. Feels like nothing; it's the
difference between the retry succeeding on attempt 2 and the retry
using all three attempts."

### Q: "How did you prove any of this works?"

"`FaultInjectingDataSource` at `lib/data-source/fault-injecting.ts` is a
`DataSource` decorator with four canonical failure modes — timeout,
rate_limit, server_error, malformed_json — each with an independent
per-call probability. Seeded xorshift32 for reproducibility. The Week
4B smoke test at `FAULT_TIMEOUT=0.2 FAULT_MALFORMED_JSON=0.2
FAULT_SEED=42`, LOAD_N=3 injected 9 faults across 3 investigations and
0 investigations failed. Receipt lives at
`eval/load-receipts/load-2026-07-03T05-21-12-237Z.json`. The
`malformed_json` fault specifically tests band 4 — the model gets a
`tool_result` with unclosed JSON in a text block, and it decides what
to do."

Sketch this:

```
                  9 faults injected
                  ─────────────────
                     ▼
   diag agent ──► tool_result is_error:true (5×)
                  tool_result with garbled text (4×)
                     │
                     ▼
                  model reasons about each
                     │
                     ▼
                  3 completed investigations, 0 failed
```

## See also

- 03-idempotency-deduplication-and-delivery-semantics.md — the 60s cache
  and what "retry" means for tool calls that mutate nothing
- 06-queues-streams-ordering-and-backpressure.md — the spacing gate is
  backpressure, teased apart there
- 09-distributed-systems-red-flags-audit.md — the risks the four bands
  don't defend against

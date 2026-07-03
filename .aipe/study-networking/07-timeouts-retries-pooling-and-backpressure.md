# Timeouts, retries, pooling, and backpressure

*Failure-domain budgets (Industry standard)* — timeouts, retries,
jitter, pools, request collapsing, and overload behavior. This is the
**load-bearing chapter** of the guide: everything the app does about
partial failure on the wire lives here, and it composes into one
three-tier budget.

## Zoom out — where this concept lives

Three budgets stacked. The outer 300s route ceiling (Vercel Pro's
`maxDuration`) contains an inner 30s per-call transport timeout, which
contains a per-call retry ladder that can wait up to 20s × 3 = 60s of
wall clock on a single rate-limited tool. Every wait is capped;
timeouts fail fast; only rate-limit results retry.

```
  Zoom out — three budgets, one composed AbortSignal

  ┌─ Vercel route (Vercel Pro) ──────────────────────────────────┐
  │  maxDuration = 300 s                                          │
  │  process killed on overshoot                                  │
  │                                                                │
  │  ┌─ MCP transport (per callTool) ────────────────────────────┐│
  │  │  TOOL_TIMEOUT_MS = 30 s                                    ││
  │  │  ★ AbortSignal.timeout composed with req.signal ★           ││
  │  │  (whichever fires first wins)                              ││
  │  │                                                             ││
  │  │  ┌─ BloomreachDataSource retry ladder ───────────────────┐ ││
  │  │  │  maxRetries = 3                                        │ ││
  │  │  │  wait = min(hint OR retryDelayMs*2^(n-1), 20 s)        │ ││
  │  │  │  fires ONLY on isError && "rate limit" text            │ ││
  │  │  │  timeouts DO NOT retry (fail fast)                     │ ││
  │  │  └────────────────────────────────────────────────────────┘ ││
  │  └────────────────────────────────────────────────────────────┘│
  └──────────────────────────────────────────────────────────────┘
```

Everything hangs on the composed signal at `lib/mcp/transport.ts:131`.

## The structure pass

Two axes matter here: **failure** (what kind of thing goes wrong?) and
**cost** (how much wall clock does the response take, and who pays?).
The load-bearing one is failure — because the retry policy depends on
being able to distinguish "timeout" from "rate limit" from "5xx".

```
  Axis: "how does this specific failure propagate?"

  ┌──────────────┬────────────────────┬───────────────────────────┐
  │ failure mode │ where it fires      │ retry policy              │
  ├──────────────┼────────────────────┼───────────────────────────┤
  │ timeout      │ AbortSignal.timeout │ NO RETRY — fail fast      │
  │ (30s)        │ inside transport    │ (retry would wait 30s     │
  │              │                     │  more inside same budget) │
  ├──────────────┼────────────────────┼───────────────────────────┤
  │ rate limit   │ result.isError with │ RETRY up to 3 times       │
  │ (429-shaped) │ "rate limit" text   │ honor parsed hint         │
  │              │ (fast response!)    │ capped at 20s wait         │
  ├──────────────┼────────────────────┼───────────────────────────┤
  │ 5xx / other  │ throws from SDK     │ NO EXPLICIT RETRY         │
  │              │                     │ (surfaces to caller)      │
  ├──────────────┼────────────────────┼───────────────────────────┤
  │ 401 invalid  │ throws with body    │ NO RETRY — auth-reset     │
  │ _token       │ text                │ dance instead (client)    │
  └──────────────┴────────────────────┴───────────────────────────┘
```

The seam that matters: the **retry ladder distinguishes failure modes
by inspecting the *result envelope*, not by catching an error.** A
rate-limit response comes back *quickly* (the server returns an error
envelope in milliseconds); a timeout means we got no response at all
in 30 seconds. Retrying a timeout would just spend another 30 seconds
learning nothing new; retrying a rate limit after the stated window
usually succeeds.

## How it works

### Move 1 — the mental model

You've written `Promise.race([fetch(url), timeout(30000)])` before to
bound a request. `AbortSignal.timeout(30_000)` is the modern
equivalent — one line, no manual `Promise.race`, and it *composes*
with any other `AbortSignal` you have. That last property is the load-
bearing one here. The route has its own `req.signal` (fires when the
browser disconnects); the transport wants a 30s ceiling; whichever
fires first should cancel. `AbortSignal.any([signalA, signalB])` gives
you exactly that.

```
  The pattern — one AbortSignal from two sources

    req.signal (client disconnect)  ─┐
                                     ├──►  AbortSignal.any([…])  ──► fetch({signal})
    AbortSignal.timeout(30_000)     ─┘
                                     first to fire wins
```

### Move 2 — the load-bearing skeleton

Three layers of budget. Isolate each.

#### Layer 1: the composed AbortSignal at the transport seam

The kernel — `lib/mcp/transport.ts:129-133`:

```ts
  async callTool(name: string, args: Record<string, unknown>, opts?: CallToolOpts): Promise<unknown> {
    if (this.httpErrors) this.httpErrors.last = null;
    const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
    try {
      return await this.client.callTool({ name, arguments: args }, undefined, { signal });
```

And `composeSignals` itself (`transport.ts:173-189`):

```ts
  export function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
    const filtered = signals.filter((s): s is AbortSignal => !!s);
    if (filtered.length === 0) return new AbortController().signal;
    if (filtered.length === 1) return filtered[0];
    if (typeof (AbortSignal as unknown as { any?: unknown }).any === 'function') {
      return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(filtered);
    }
    const ac = new AbortController();
    for (const s of filtered) {
      if (s.aborted) {
        ac.abort((s as unknown as { reason?: unknown }).reason);
        return ac.signal;
      }
      s.addEventListener('abort', () => ac.abort((s as unknown as { reason?: unknown }).reason), { once: true });
    }
    return ac.signal;
  }
```

`AbortSignal.any` (Node 20+, modern browsers) does the composition
natively. The manual fallback is belt-and-braces — in this Node
runtime it's not hit, but the code doesn't assume that.

**Name each part by what breaks if missing:**

  - Drop the `AbortSignal.timeout(30_000)` and a stuck upstream can burn
    the whole 300s route budget on one call.
  - Drop the `opts?.signal` composition and a client that closes the
    tab can't cancel in-flight upstream calls — the browser hangs up
    but the route keeps spending money on Anthropic tokens for another
    30s.
  - Drop the whole `composeSignals` and use two separate abort controllers
    and you have a race condition where one signal's `abort()` doesn't
    reach the other.

#### Layer 2: the timeout error tag

Timeouts fail fast, and they fail *distinctly* — `transport.ts:44-48, 135-137`:

```ts
  function isTimeoutError(err: unknown): boolean {
    if (!err || typeof err !== 'object' || !('name' in err)) return false;
    const name = (err as { name?: unknown }).name;
    return name === 'AbortError' || name === 'TimeoutError';
  }

  // …later, inside callTool's catch…
  if (isTimeoutError(err)) {
    throw new Error(`HTTP 0: timeout after ${TOOL_TIMEOUT_MS}ms`, { cause: err });
  }
```

The `HTTP 0:` tag matters for observability. `HTTP 0` isn't a real
status code — but it slots into the same error-shape scheme as
`HTTP 401: …` or `HTTP 500: …`, so a log grep for `HTTP \d+` still
matches timeout events. The fault-injection decorator mimics this shape
exactly (`lib/data-source/fault-injecting.ts:115`) so offline tests
exercise the same error path.

#### Layer 3: the retry ladder — rate-limit only, capped

The whole ladder lives in `BloomreachDataSource.callTool`
(`lib/data-source/bloomreach-data-source.ts:163-174`):

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

**Trace execution.** Suppose the Bloomreach server has just told us
"rate limit reached (1 per 10 second)":

```
  Execution trace — rate-limited call, one server-stated window

  retries = 0, result = { isError: true, content: [...'1 per 10 second'...] }

  iter 1:
    isRateLimited(result) = true, retries < 3 → enter loop
    retries = 1
    hintMs = parseRetryAfterMs → 10_000 ms  (parsed from "10 second")
    backoffMs = 10_000 * 2^0 = 10_000
    waitMs = min(10_000 + 500, 20_000) = 10_500 ms
    sleep(10500)
    result = liveCall(...)   ← same call again

  Suppose result is still rate-limited:
  iter 2:
    retries = 2
    hintMs = 10_000
    backoffMs = 10_000 * 2^1 = 20_000
    waitMs = min(10_500, 20_000) = 10_500  ← hint wins over backoff
    sleep(10500)
    result = liveCall(...)

  Suppose result is finally ok:
  loop exits, cache the result, return.

  Total wall clock for one call: ~21s + call latency.
  Total budget within maxRetries = 3: worst case ~31.5s of waits + 3 calls.
```

**Configuration values that produce this behavior**
(`bloomreach-data-source.ts:129-137`):

```ts
  constructor(private transport: McpTransport, opts: ClientOpts = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 200;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 10_000;
    this.retryCeilingMs = opts.retryCeilingMs ?? 20_000;
  }
```

And the actual values passed at construction time
(`lib/mcp/connect.ts:96-101`):

```ts
      mcp: new BloomreachDataSource(new SdkTransport(client, httpErrors), {
        minIntervalMs: 1100,           // ← ~1.1s proactive spacing
        retryDelayMs: 10_000,          // ← fallback base if no hint
        retryCeilingMs: 20_000,        // ← per-wait ceiling
        maxRetries: 3,
      }),
```

**Skeleton vs hardening:**
  - Kernel: the while-loop with a wait between attempts.
  - Hardening:
    - `parseRetryAfterMs` — parses the server's stated window from the
      error text. This is what makes the wait match the *actual*
      penalty rather than blind backoff.
    - `RETRY_BUFFER_MS = 500` — added on top of the parsed hint so
      the retry lands just *after* the penalty clears, not on its
      boundary (which would race and get another 429).
    - `retryCeilingMs = 20_000` — bounds any single wait, so a
      pathological "please wait 5 minutes" hint doesn't blow the
      route budget.
    - `isError`-only retry — no throw catches; the retry inspects the
      structured result.
    - No-cache-on-error at `bloomreach-data-source.ts:179-181` — a
      failed retry doesn't poison the 60s response cache.

#### The proactive spacing — pre-emptive rate limiting

Before the retry ladder even considers running, `liveCall` enforces a
minimum interval between successful calls (`bloomreach-data-source.ts:190-198`):

```ts
  private async liveCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const elapsed = Date.now() - this.lastCallAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }
    try {
      const result = await this.transport.callTool(name, args, { signal });
      this.lastCallAt = Date.now();
```

`minIntervalMs = 1100` = 1.1 seconds. The comment at `connect.ts:87-92`
explains why not 10 seconds:

> Bloomreach rate-limits per user GLOBALLY and states the window in
> the error text — observed as both "(1 per 1 second)" and "(1 per 10
> second)". Proactive spacing stays at ~1.1s on purpose: spacing at
> the full 10s window would cost ~60s for a 6-call investigation and
> blow the route's 60s budget…

That's the tradeoff: pay a small amortized cost on every call to avoid
running into the retry ladder on most of them, and reserve the ladder
for the times when the observed window is actually 10s.

#### Backpressure — none, and here's why

There's no explicit backpressure mechanism (no queue depth limit, no
in-flight-request counter, no `429`-shaped response back to the browser).
The app doesn't need one because:

  - One user per session, ~15 calls per briefing, all serial (the
    agent loop is sequential — one tool call, wait, next tool call).
  - The 1.1s spacing acts as *implicit* backpressure: even a runaway
    loop can't outpace the server faster than 1 call per 1.1 seconds.
  - The route budget (300s) is the hard ceiling — a runaway loop hits
    the process wall and Vercel kills it.

If the app ever fanned out to multiple concurrent calls per user or
multiple users on one Node instance, you'd want a semaphore around
`liveCall` — the current `lastCallAt` state is per-instance and not
concurrency-safe.

### Move 2.5 — where each budget wins

Three failure scenarios, one composition:

```
  Scenario A: user closes tab mid-stream
  ────────────────────────────────────────
   client disconnect → req.signal fires
   composed signal fires immediately
   in-flight callTool aborts
   route finally runs, logs aborted: true
   process exits (well under 300s)

  Scenario B: Bloomreach hangs (network partition)
  ─────────────────────────────────────────────────
   callTool waits… no response…
   AbortSignal.timeout(30_000) fires at 30s
   isTimeoutError(err) → throw HTTP 0: timeout after 30000ms
   NO RETRY — fail fast, next call proceeds
   route may still succeed with the remaining calls

  Scenario C: Bloomreach rate-limits us
  ─────────────────────────────────────────
   callTool returns FAST with result.isError = true, "1 per 10 second"
   isRateLimited(result) = true
   parseRetryAfterMs = 10_000, wait 10_500ms
   retry, likely succeeds now
   total wall clock: ~11s for this call

  Scenario D: Bloomreach revokes token mid-stream
  ────────────────────────────────────────────────
   callTool → HTTP 401 invalid_token
   throws from SdkTransport
   McpToolError wraps it
   route sends {type:'error', message: "…invalid_token…"}
   client's reconnect policy handles it (see file 06)
```

### Move 3 — the principle

Every failure has a distinct signal — timeout vs rate-limit vs 401 —
and each signal has a distinct policy. Retrying a timeout is
worse-than-useless (it wastes budget); retrying a rate limit after the
stated window usually succeeds. The load-bearing move is *not the
retry itself* — it's the classification that decides whether to
retry, driven by inspecting the response envelope.

## Primary diagram

```
  Primary — the three-tier budget composed

  ┌─ Route (maxDuration = 300s) ────────────────────────────────────┐
  │                                                                   │
  │  req.signal (fires on client disconnect)                          │
  │      │                                                             │
  │      │        ┌─ per callTool ───────────────────────────────────┐│
  │      │        │                                                    ││
  │      └───────►│  composeSignals(                                   ││
  │  AbortSignal  │    req.signal,                                     ││
  │  .timeout(30k)┼──►  AbortSignal.timeout(30_000)                    ││
  │      │        │  )                                                  ││
  │      │        │  transport.callTool(name, args, { signal })          ││
  │      │        │      │                                                ││
  │      │        │      │  network …                                     ││
  │      │        │      ▼                                                ││
  │      │        │  fast rate-limit response                             ││
  │      │        │      │                                                ││
  │      │        │      ▼                                                ││
  │      │        │  isRateLimited(result)?                                ││
  │      │        │      │ yes                                            ││
  │      │        │      ▼                                                ││
  │      │        │  wait = min(hint OR backoff, 20_000)                   ││
  │      │        │  sleep(wait); retry up to maxRetries=3                ││
  │      │        │                                                        ││
  │      │        │  BUT if AbortSignal.timeout fires first:               ││
  │      │        │      throw HTTP 0: timeout after 30000ms — NO RETRY   ││
  │      │        └────────────────────────────────────────────────────┘  │
  │                                                                       │
  │  finally logs { phases, totalMs, aborted: req.signal.aborted }         │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Why fail-fast on timeout but retry on rate limit?** The information
content of the two failures differs:

  - Timeout = "no response received." Retrying gives you no new
    information; you might just wait another 30s. The server is either
    down or the network is partitioned; either way the app can't fix
    it.
  - Rate limit = "response received; server is telling you to wait
    exactly N seconds and try again." Retrying is exactly what the
    server asked for. The information (the parsed window) makes the
    wait bounded and productive.

**Why 20s ceiling on any single wait when the observed window is
10s?** Defense against a pathological server response ("please wait
900 seconds"). The parsed hint is trusted only up to the ceiling; a
malicious or buggy server can't burn the whole budget.

**Why no jitter?** The app has one client at a time, so thundering-herd
doesn't apply. The `RETRY_BUFFER_MS = 500` acts as a fixed jitter that
lands the retry just after the stated window. If the app ever ran with
multiple concurrent users hitting the same `1 per 10 second` window, a
±1s randomization would prevent synchronized retries.

**Why 60s response cache in the middle of all this?** Two reasons:
(1) repeated identical calls within a briefing skip the whole retry
ladder — cache hit, no network, done in 0ms. (2) it lets the retry
ladder be more conservative — if a call succeeds after 20s of retries,
the next identical call within 60s is free.

## Interview defense

**Q: You have a 300s route budget and each tool call can take up to
30s + 60s of retry waits. What stops one bad call from eating the
whole budget?**

  Verdict first: the per-call 30s ceiling is on the *HTTP round-trip*
  itself. The 60s of retry wall clock only applies when the *response*
  comes back quickly (fast rate-limit envelope) — because the retry
  runs after a fast failure. A stuck upstream fails at 30s once and
  the ladder never fires.

```
  answer sketch — timeout ≠ retry-triggering

  stuck upstream (no response):
    30s AbortSignal.timeout → throw HTTP 0 → fail fast
    no retry (isRateLimited(err) doesn't fire)
    total: 30s, then next call proceeds

  rate-limited (fast response):
    ~200ms round trip → isError + "rate limit"
    retry ladder: up to 3 waits × 20s = 60s wall clock
    total: ~60s + 3 × ~200ms fast responses
    but this only happens because the responses are fast

  worst-case single call: 30s (timeout) + no retry = 30s
  worst-case rate-limited call: 60s + fast round trips = ~61s
```

  Anchor: `lib/mcp/transport.ts:38, 131-138`,
  `lib/data-source/bloomreach-data-source.ts:163-174`.

**Q: How does the client cancel an in-flight LLM call when the user
navigates away?**

  Direct: one composed AbortSignal reaches every level. Client sets
  `cancelledRef.current = true`; `readNdjson` calls `reader.cancel()`;
  the underlying fetch's request signal fires `AbortError` on the
  server; the route's `req.signal` is composed with the per-call 30s
  timeout via `AbortSignal.any` and passed as the `signal` option on
  every `callTool` and on `anthropic.messages.create`. So the same
  abort that closed the browser stream cancels the in-flight upstream
  LLM call.

```
  answer sketch — one signal, three layers

  cancelledRef.current = true  (client cleanup)
       ↓
  reader.cancel() → RST_STREAM (HTTP)
       ↓
  req.signal.aborted = true (route)
       ↓ composed with AbortSignal.timeout(30_000)
  fetch({signal}) aborts (transport)
       ↓
  anthropic.messages.create({signal}) aborts (SDK)
```

  Anchor: `lib/streaming/ndjson.ts:33-36`,
  `lib/mcp/transport.ts:131,173-189`,
  `lib/agents/aptkit-adapters.ts:92-95`.

**Q: What's missing from this retry policy that a production system
at scale would want?**

  Direct: three things. (1) *Jitter* — the current deterministic wait
  creates thundering-herd risk if multiple users hit the same window;
  fine at 1 user but not at N. (2) *Cross-request state* — the
  1.1s spacing is per-instance; two Node instances handling two
  requests can each fire in the same 1s window. A shared token
  bucket (Redis) would fix that. (3) *Circuit breaker* — after N
  consecutive timeouts on the same origin, stop calling entirely for
  a cool-down period. Currently every call independently absorbs the
  30s timeout.

  Anchor: same files; the absence is the point.

## See also

  - `01-network-map.md` — where each timeout sits on the wire
  - `03-tcp-udp-connections-and-sockets.md` — connection pooling under the hood
  - `06-websockets-sse-streaming-and-realtime.md` — how the client-side abort
    composes with the fetch stream
  - `08-networking-red-flags-audit.md` — the ranked risks that come out of these
    tradeoffs

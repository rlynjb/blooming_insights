# 07 — timeouts, retries, pooling, and backpressure

## Subtitle

Overload and failure containment on the outbound hops (Language-agnostic — the ceiling on any single call, the retry ladder for rate-limits, the response cache that absorbs repeats).

## Zoom out, then zoom in

Two upstream servers, both flaky enough to matter: Bloomreach rate-limits per user globally (~1 req/s, sometimes ~1 per 10s), and any HTTPS server anywhere can stall a socket indefinitely. This layer is the app's defense: a 30-second per-call ceiling composed via `AbortSignal.timeout`, a retry ladder that parses the server's own stated wait time from the error text, a 60-second in-memory response cache, and a proactive ~1.1-second gap between calls. Every one of these is inside `lib/mcp/transport.ts` or `lib/data-source/bloomreach-data-source.ts`.

```
  Zoom out — where overload defenses sit

  ┌─ UI layer ─────────────────────────────────────────────────┐
  │  browser fetch — no timeout, no retry                      │
  │  (relies on route's stream + reconnect policy)             │
  └────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
  ┌─ Service band (route) ─────────────────────────────────────┐
  │  maxDuration = 300s (Vercel Pro budget)                    │
  │  req.signal threaded to every async layer                  │
  └────────────┬──────────────────────────────┬────────────────┘
               │                              │
               ▼                              ▼
  ┌─ BloomreachDataSource ────────┐  ┌─ Anthropic call ───────┐
  │  ★ THIS FILE ★                │  │  no explicit timeout;  │
  │  · 60s cache                  │  │  relies on route abort │
  │  · ~1.1s proactive gap        │  │  signal only           │
  │  · retry ladder (3× max)      │  │                        │
  └────────────┬──────────────────┘  └────────────────────────┘
               │
               ▼
  ┌─ SdkTransport (lib/mcp/transport.ts) ──────────────────────┐
  │  · AbortSignal.timeout(30_000) per call                    │
  │  · composed with route's req.signal                        │
  │  · first-fires wins                                        │
  │  · timeout thrown as HTTP 0: timeout after 30000ms         │
  └────────────────────────────────────────────────────────────┘
```

Zoom in — this file walks every defense in order. The 30s ceiling. The retry ladder. The 60s response cache. The proactive spacing. Then the intentional gaps: no retry on timeout, no jitter on the retry hint, no connection pool tuning.

## Structure pass

**Layers:**
- Route (300s budget, cancels on client abort)
- BloomreachDataSource (cache, spacing, retry)
- SdkTransport (per-call 30s timeout)
- MCP server (rate-limits, returns 429 with stated window)

**Axis — FAILURE (where does each failure mode terminate?):**

```
  "who catches this failure?" — traced down the stack

  browser closes tab       → req.signal aborts
                              → composed into transport signal
                              → in-flight fetch aborts
                              → route catches AbortError, exits clean
  MCP call takes >30s      → AbortSignal.timeout fires
                              → transport throws HTTP 0: timeout
                              → NOT retried (deliberate)
                              → surfaces as tool_call_end error event
  MCP returns 429          → parseRetryAfterMs extracts window
                              → sleep(min(hint + 500ms buffer, 20s))
                              → retry, up to 3 attempts
                              → if still 429 after 3, surfaces as error
  Cached result available  → return immediately (0ms)
                              → no call, no risk of failure
  Same call within 1.1s    → sleep to enforce spacing
                              → prevents self-inflicted 429

  failure is contained at each seam;
  timeouts fail fast, rate limits patiently wait, cache absorbs repeats
```

**Seams:**
- Seam #1 — cache boundary: a hit means zero risk.
- Seam #2 — the 30s ceiling: failure fast (no retry, so no chained latency).
- Seam #3 — the retry ladder: failure patient (parses server hint, respects ceiling).

## How it works

### Move 1 — the mental model

Four rings of defense around every outbound MCP call, checked in order:

```
  Rings of defense around a single MCP callTool

    ┌──────────────────────────────────────────────┐
    │  1. cache lookup                             │
    │     if hit → return, 0ms, no network         │
    └───────────────┬──────────────────────────────┘
                    │ miss
                    ▼
    ┌──────────────────────────────────────────────┐
    │  2. proactive spacing (~1.1s minInterval)    │
    │     if lastCallAt < now - 1100ms:            │
    │       sleep(1100 - elapsed)                  │
    │     — avoids self-inflicted 429              │
    └───────────────┬──────────────────────────────┘
                    │
                    ▼
    ┌──────────────────────────────────────────────┐
    │  3. per-call timeout ceiling (30s)           │
    │     composed with route's req.signal         │
    │     first-fires wins                         │
    │     → HTTP 0: timeout after 30000ms          │
    └───────────────┬──────────────────────────────┘
                    │
                    ▼
    ┌──────────────────────────────────────────────┐
    │  4. rate-limit retry ladder (up to 3×)       │
    │     if result.isError && text ~= /rate limit/│
    │       parse retry-after hint from error text │
    │       sleep(min(hint + 500ms, 20s ceiling))  │
    │       retry                                  │
    └──────────────────────────────────────────────┘
```

Each ring catches a different failure class. Cache absorbs "already answered this." Spacing avoids "we caused a rate limit." Timeout catches "server stalled." Retry ladder patiently waits out "server rate-limited us anyway."

### Move 2 — the walkthrough

#### The 30-second per-call ceiling (the load-bearing one)

Every MCP call gets an `AbortSignal.timeout(30_000)` composed with the route's cancel signal. Whichever fires first cancels the in-flight fetch. From `lib/mcp/transport.ts:38, 129-146`:

```ts
const TOOL_TIMEOUT_MS = 30_000;

// ...

async callTool(name: string, args: Record<string, unknown>, opts?: CallToolOpts): Promise<unknown> {
  if (this.httpErrors) this.httpErrors.last = null;
  const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
  try {
    return await this.client.callTool({ name, arguments: args }, undefined, { signal });
  } catch (err) {
    // Timeout path — distinct `HTTP 0:` tag so callers can recognize it.
    if (isTimeoutError(err)) {
      throw new Error(`HTTP 0: timeout after ${TOOL_TIMEOUT_MS}ms`, { cause: err });
    }
    const captured = this.httpErrors?.last;
    if (captured) {
      const body = captured.body.trim();
      throw new Error(`HTTP ${captured.status}${body ? `: ${body}` : ''}`, { cause: err });
    }
    throw err;
  }
}
```

**Why this is the strongest single defense in the whole stack.**

Without it: a stuck Bloomreach socket could sit indefinitely (Node's default socket timeout is ~2 minutes, and even that's not guaranteed with active bytes flowing). One hung call would burn 100+ seconds of a 300-second route budget on nothing. The diagnostic loop, which runs ~5-15 tool calls, becomes brittle to any one of them stalling.

With it: worst case, a single stuck call costs 30 seconds and returns `HTTP 0: timeout after 30000ms` to the caller. The loop moves on. The 300s budget stays predictable.

**The `HTTP 0:` tag is deliberate signaling.** No HTTP response was received (the socket was aborted before the server responded). Naming it as `HTTP 0` — distinct from `HTTP 4xx` or `HTTP 5xx` — lets pattern-matching consumers distinguish "server stalled" from "server said no." The fault-injection surface uses the same tag (`lib/data-source/fault-injecting.ts:121`) so tests exercise the same error path.

**Why the retry ladder deliberately does NOT retry a timeout.** From the transport.ts comment (34-37):

> The retry ladder in McpClient.callTool only retries successful-but-rate-limited results, so the timeout error fails fast — exactly what we want, since a retry would just risk another 30s wait inside the same route budget.

Retrying a timeout with maxRetries=3 would blow the route budget: 30s + 30s + 30s + 30s = 120s on a single tool call. Instead, timeout fails fast and the ReAct loop can continue with the remaining budget.

#### The retry ladder — for rate limits only

`BloomreachDataSource` wraps every `callTool` in a retry loop that fires ONLY when the result comes back rate-limited. From `lib/data-source/bloomreach-data-source.ts:154-174`:

```ts
const start = Date.now();
let result = await this.liveCall(name, args, options.signal);

// Rate-limit retry. Bloomreach enforces a multi-second global window and
// states it in the error text; honor the parsed hint, else exponential
// backoff off retryDelayMs — every wait capped at retryCeilingMs.
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

**Walk it one part at a time:**

1. `isRateLimited(result)` — pattern-matches on the result envelope's error text for `/rate limit|too many requests/i`. This is a *successful* HTTP response with an in-body error marker; Bloomreach returns 200 OK with `isError: true` for rate limits, not 429.
2. `parseRetryAfterMs(result)` — pulls the wait hint out of the error message. Two observed shapes:
   - `"Retry after ~12 second(s)"` → 12,000ms
   - `"rate limit reached (1 per 10 second)"` → 10,000ms (the penalty window)
3. `hintMs + RETRY_BUFFER_MS` — 500ms cushion so the retry lands just *after* the penalty window clears, not on its boundary.
4. `Math.min(..., retryCeilingMs)` — 20-second ceiling. Even if Bloomreach stated 60s, wait no more than 20s. Prevents a single call from blowing the route budget.
5. Fallback to `backoffMs = retryDelayMs * 2 ** (retries - 1)` — exponential backoff (10s, 20s, 40s) when no hint is parseable. Also capped at 20s.

```
  Retry ladder — wait times per attempt

  attempt 1:  → call, get 429 with "per 10 second"
              → wait 10s + 500ms buffer = 10.5s (capped at 20s → 10.5s)

  attempt 2:  → call, get 429 with "per 10 second"
              → wait 10s + 500ms buffer = 10.5s

  attempt 3:  → call, get 429 with "per 10 second"
              → wait 10s + 500ms buffer = 10.5s

  attempt 4:  (would have been the retry, but maxRetries=3 so stop)
              → surface the 429 as the final error

  total worst case: ~31s of waiting + 4 calls' HTTP latency
  (against the 300s route budget)
```

**Load-bearing details worth naming:**

- **maxRetries=3 is a budget decision, not a correctness one.** More retries would mean higher chance of success but also higher chance of blowing the route budget on one call. Three is the tension point.
- **No jitter.** Bloomreach's rate limit is per-user global; multiple concurrent users hitting the same limit would ideally jitter their retries to avoid synchronizing. Not exercised because there's exactly one user per request in this app's model.
- **Only rate-limit results retry.** Timeouts, 5xx errors, network errors — none retry. The retry ladder is scoped to a specific failure class where retrying is known to be productive.

#### Proactive spacing — the ~1.1s minInterval

Every call spaces itself from the last. From `lib/data-source/bloomreach-data-source.ts:190-194`:

```ts
private async liveCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  // ...
}
```

`minIntervalMs` defaults to 1100 (from `lib/mcp/connect.ts:120-125`, configured for the Bloomreach preset). The rationale — from that comment:

> Proactive spacing stays at ~1.1s on purpose: spacing at the full 10s window would cost ~60s for a 6-call investigation and blow the route's 60s budget (app/api/agent). Instead, BloomreachDataSource parses the stated window from each 429 and waits it out on retry.

So the strategy is: **stay just under the tightest documented window (1 per 1 second) on the happy path, react to 429s when the tighter window (1 per 10 seconds) is enforced.** Not perfect — you eat 429s sometimes — but it keeps the route budget realistic.

#### The 60-second response cache

Every non-error `callTool` result gets cached under a key of `name:JSON.stringify(args)`. From `lib/data-source/bloomreach-data-source.ts:139-152, 178-187`:

```ts
async callTool<T = unknown>(
  name: string,
  args: Record<string, unknown>,
  options: CallToolOptions = {},
): Promise<CallToolResult<T>> {
  const cacheKey = `${name}:${JSON.stringify(args)}`;
  const ttl = options.cacheTtlMs ?? 60_000;

  if (!options.skipCache) {
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { result: cached.result as T, durationMs: 0, fromCache: true };
    }
  }

  // ... live call + retry ...

  // Don't cache error results — they should not poison the cache.
  if ((result as any)?.isError === true) {
    return { result: result as T, durationMs, fromCache: false };
  }
  const now = Date.now();
  this.cache.set(cacheKey, { result, expiresAt: now + ttl });
  return { result: result as T, durationMs, fromCache: false };
}
```

**Load-bearing details:**

- **60-second TTL matches the Bloomreach rate-limit window.** By the time cache entries expire, the rate limit has cleared for repeat calls.
- **Errors don't cache.** A rate-limit error at t=0 would poison the cache for 60s and prevent the retry from ever succeeding. The explicit `isError === true` check excludes these.
- **`skipCache` is per-call opt-out.** The `/debug` page's "force fresh" button sets this; the agent loop always uses cache.
- **`skipCache` still refreshes on write-through.** A `skipCache=true` call bypasses the read but writes the fresh result back to cache. Correct for the "force fresh, then reuse" pattern.

The cache is process-local (`Map` in memory). On Vercel, each function instance has its own cache. A cache hit rate high enough to matter requires request affinity or a warm instance — which Vercel provides sometimes but doesn't guarantee. Best-effort optimization.

#### The AbortSignal composition — why cancellation actually works

The `composeSignals` helper in `lib/mcp/transport.ts:173-189` builds one signal that fires when any input signal fires:

```ts
export function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const filtered = signals.filter((s): s is AbortSignal => !!s);
  if (filtered.length === 0) return new AbortController().signal;
  if (filtered.length === 1) return filtered[0];
  if (typeof (AbortSignal as unknown as { any?: unknown }).any === 'function') {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(filtered);
  }
  // fallback for older runtimes ...
}
```

Prefers `AbortSignal.any` (Node 20+ / modern browsers) which is the built-in "fire on first" primitive. Falls back to a manual `AbortController` glue for older runtimes.

The load-bearing use: **the route's `req.signal` (fires when the browser closes the tab) composed with `AbortSignal.timeout(30_000)` (fires after 30s).** Whichever fires first cancels the fetch. Without composition, aborting the inbound socket doesn't propagate to the outbound socket — it would keep running until its own timeout, wasting cost.

#### Anthropic-side timeouts — not this file's job

The Anthropic SDK call gets the route's `req.signal` threaded through, but no additional per-call ceiling. From `lib/agents/aptkit-adapters.ts:92-95`:

```ts
const response = await this.anthropic.messages.create(
  params,
  request.signal ? { signal: request.signal } : undefined,
);
```

The relationship is asymmetric: MCP calls get a 30s ceiling because Bloomreach can stall silently, but Anthropic calls rely on the route's 300s budget as the only ceiling. Anthropic's own SDK likely has internal timeouts; not explicitly set here.

#### Connection pool — implicit, not tuned

Node's `undici` (backing global `fetch`) pools TCP connections per host automatically. No explicit `Agent` or pool config in this repo (verified: `grep httpAgent|keep-alive|keepalive` → no matches). Pool size is `undici`'s default; keep-alive is default on.

The consequence: first outbound call per host per function invocation pays a TCP+TLS handshake. Subsequent calls to the same host reuse the pooled connection. On a warm Vercel instance the pool persists across requests, so consecutive investigations see hot handshakes; on a cold instance the first call pays.

Not tuned because there's no evidence tuning would help. If sustained load became a concern, this is where you'd add an explicit `undici.Agent` with a larger pool ceiling.

#### No backpressure signaling to the browser

The route's `controller.enqueue` calls don't await backpressure. If the browser reads slowly, bytes accumulate in Node's write buffer, but the route keeps pushing events. For the event sizes in this app (each event ~1-4KB) and the number of events per investigation (~20-50), the buffer doesn't fill in practice.

Would matter if events got much larger or the browser was actually slow to consume. Not exercised.

### Move 3 — the principle

**Fail fast where recovery is impossible; fail patiently where the server told you when to retry.** The 30s timeout says "if this call is stuck, admit it and move on — the ReAct loop can decide what to do next." The retry ladder says "if the server said 'wait 10 seconds,' wait 10.5 seconds and try again — the server is telling you the truth about when it'll accept." Which posture to take is a per-failure-mode decision, not a global one. This is why the transport doesn't retry timeouts and the data source only retries rate limits.

## Primary diagram

```
  Every defense on one MCP call

  agent code:
    result = await dataSource.callTool('foo', { arg: 1 }, { signal: req.signal })
       │
       ▼
  ┌─ BloomreachDataSource.callTool ────────────────────────────┐
  │                                                            │
  │  cacheKey = 'foo:{"arg":1}'                                │
  │                                                            │
  │  ┌─ if !skipCache && cache.has(cacheKey) ─────────────┐    │
  │  │   return { fromCache: true, durationMs: 0 }        │    │
  │  └─────────────────────────────────────────────────────┘    │
  │                                                            │
  │  ┌─ retry loop, up to 3× ─────────────────────────────┐    │
  │  │                                                    │    │
  │  │  ┌─ liveCall ────────────────────────────────┐     │    │
  │  │  │                                           │     │    │
  │  │  │  if now - lastCallAt < 1100ms:            │     │    │
  │  │  │    sleep(1100 - elapsed) ← proactive gap  │     │    │
  │  │  │                                           │     │    │
  │  │  │  ┌─ SdkTransport.callTool ────────────┐   │     │    │
  │  │  │  │                                    │   │     │    │
  │  │  │  │  signal = composeSignals(          │   │     │    │
  │  │  │  │    req.signal,                     │   │     │    │
  │  │  │  │    AbortSignal.timeout(30_000)     │   │     │    │
  │  │  │  │  )                                 │   │     │    │
  │  │  │  │                                    │   │     │    │
  │  │  │  │  ┌─ fetch (undici) ────────────┐   │   │     │    │
  │  │  │  │  │  pooled per-host connection │   │   │     │    │
  │  │  │  │  │  HTTPS POST /mcp/           │   │   │     │    │
  │  │  │  │  │  Authorization: Bearer ...  │   │   │     │    │
  │  │  │  │  └─────────────────────────────┘   │   │     │    │
  │  │  │  │                                    │   │     │    │
  │  │  │  │  timeout? → HTTP 0: timeout...     │   │     │    │
  │  │  │  │              (NOT retried)         │   │     │    │
  │  │  │  │  non-2xx? → HTTP <status>: <body>  │   │     │    │
  │  │  │  │              (redacted; NOT retried)│   │     │    │
  │  │  │  │  ok?       → tool result envelope  │   │     │    │
  │  │  │  └────────────────────────────────────┘   │     │    │
  │  │  └───────────────────────────────────────────┘     │    │
  │  │                                                    │    │
  │  │  if isRateLimited(result):                         │    │
  │  │    hint = parseRetryAfterMs(result)                │    │
  │  │    wait = min(hint + 500ms || backoff, 20s)        │    │
  │  │    sleep(wait); retry                              │    │
  │  │                                                    │    │
  │  └────────────────────────────────────────────────────┘    │
  │                                                            │
  │  if !isError: cache.set(cacheKey, result, ttl=60_000)      │
  │  return { fromCache: false, durationMs, result }           │
  │                                                            │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

**Why the 60s cache TTL matches the rate-limit window.** Bloomreach's tighter observed window is "1 per 10 seconds." If a call returns fresh at t=0, the same call at t=60s would be well past that window on the server. Caching for 60s is aggressive enough to absorb any within-investigation repeat but not so long that stale data leaks across investigations.

**Why `HTTP 0:` as a tag.** The pattern is deliberate. `HTTP 0` means "no HTTP response ever came back" — distinct from an HTTP 4xx (server said no) or 5xx (server broke). Tests, fault injection, and future observability layers can all pattern-match on the prefix. `lib/data-source/fault-injecting.ts:121` uses the exact same shape:

```ts
// Shape mimics lib/mcp/transport.ts:137 — `HTTP 0: timeout after 30000ms`.
throw new Error(`HTTP 0: timeout after 30000ms`, {
  cause: new Error('injected fault: timeout'),
});
```

The fault-injection surface preserves the shape so the agent's error-handling paths get exercised offline.

**The Anthropic call has no per-call timeout — why not.** Anthropic's own SDK has retries and internal timeouts, and the route's 300s budget acts as the final ceiling. Adding another explicit timeout would compound with the SDK's internals. If the Anthropic call started stalling routinely, this would be the file to add one — but so far the baseline says the diagnostic phase's 50s p50 is dominated by MCP calls, not Anthropic.

**On not tuning the connection pool.** `undici`'s defaults handle this app's traffic just fine. If we saw evidence of pool exhaustion (calls waiting for a socket) or excessive handshake counts, we'd add an explicit `Agent`. No such evidence in the baseline metrics. Would matter more on a long-running Node server; on Vercel's ephemeral functions the pool discards on function end anyway.

**What's not exercised.** Circuit breakers (per-host failure-rate tracking that opens the circuit and fails fast for a cool-down period). Load shedding (dropping requests when a queue backs up). Request collapsing (deduplicating in-flight identical requests instead of just cached ones). Adaptive concurrency (raising/lowering pool size based on observed latency). None are needed at current scale; all would become relevant with sustained high traffic.

**The proactive gap and the retry ladder are complementary.** The gap keeps happy-path calls under the 1/s window (avoids the tighter 1/10s trigger). The retry ladder is the safety net when Bloomreach enforces the tighter window anyway. Together they aim to keep an investigation's tool count (~5-15 calls) inside the route's 300s budget most of the time.

## Interview defense

**Q: Walk me through what happens if one Bloomreach call hangs.**

The `AbortSignal.timeout(30_000)` inside `SdkTransport.callTool` fires. `undici` cancels the fetch, the socket closes. The transport's catch checks `isTimeoutError` (matches `AbortError` or `TimeoutError` by name) and throws `HTTP 0: timeout after 30000ms`. `BloomreachDataSource.liveCall` catches, tags it as an `McpToolError('foo', 'HTTP 0: timeout after 30000ms')`, and rethrows.

Crucially, the retry ladder does NOT catch this. Rate-limit retries are the only case; timeouts fail fast because retrying would risk another 30s wait inside the same 300s route budget. The agent's ReAct loop sees the error as a tool result, decides whether to try a different tool or give up, and the investigation continues (or terminates gracefully).

```
  time budget on a stuck call:
    without 30s timeout: possibly minutes → burns 300s route budget
    with 30s timeout:    exactly 30s → 270s left for the loop to recover
```

Anchor: `lib/mcp/transport.ts:38, 131-137`.

**Q: How does the retry ladder decide how long to wait?**

Three-step decision:

1. **Parse the server's own stated window.** Bloomreach returns 429 with text like `"rate limit reached (1 per 10 second)"` or `"Retry after ~12 second(s)"`. Regex extracts the number.
2. **Add a 500ms buffer.** The retry lands just after the window clears, not on its boundary.
3. **Cap at 20s ceiling.** Even if the server said 60s, wait no more than 20s. Prevents any single retry from blowing the route budget.

If no hint is parseable, fall back to exponential backoff (`10s, 20s, 40s`) capped at 20s.

Max 3 retries. Worst case: ~31s of waiting + 4 calls' latency, on the 300s route budget.

Anchor: `lib/data-source/bloomreach-data-source.ts:60-71, 154-174`.

**Q: What's the load-bearing detail people forget when they build this shape?**

The `AbortSignal` composition. If you set a per-call timeout but don't compose it with the route's cancel signal, closing the browser tab doesn't propagate to the outbound MCP call — it keeps running until its own timeout, wasting 30s of cost per stuck call.

`composeSignals(req.signal, AbortSignal.timeout(30_000))` uses `AbortSignal.any` (Node 20+) so whichever fires first cancels the fetch. One line, but the cancellation story wouldn't work end-to-end without it.

Anchor: `lib/mcp/transport.ts:131, 173-189`.

## See also

- `03-tcp-udp-connections-and-sockets.md` — how the 30s ceiling relates to socket lifecycle
- `05-http-semantics-caching-and-cors.md` — the response cache in the broader HTTP-caching story
- `08-networking-red-flags-audit.md` — where these defenses have gaps (no jitter, no circuit breaker, no Anthropic timeout)
- `study-distributed-systems` — same rate-limit + retry topic seen from "coordination under partial failure"

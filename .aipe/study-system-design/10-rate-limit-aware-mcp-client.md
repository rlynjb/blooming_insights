# rate-limit-aware-mcp-client

## Token-bucket-adjacent client with retry ladder + response cache (industry standard)

The Bloomreach adapter (`BloomreachDataSource`, 214 LOC) carries every reliability mechanic the upstream forces on us: 1.1s proactive spacing between calls, a retry ladder that parses the server's stated penalty window from the error text, a 60s response cache that absorbs repeated calls within a briefing, and `AbortSignal` composition so cancellation propagates from the route. The agent loop above sees a simple `callTool(...) → { result, durationMs, fromCache }` — every retry, every wait, every cache hit is hidden behind that surface.

## Zoom out — where this pattern lives

The reliability machinery lives entirely inside one adapter. Above the adapter (agents, routes), nothing knows about rate limits. Below the adapter (network), every quirk of the upstream is absorbed.

```
  Zoom out — reliability concentrated in one adapter

  ┌─ Service layer ───────────────────────────────────────────────────┐
  │  agents (monitoring, diagnostic, recommendation, query)            │
  │      │                                                             │
  │      │ await dataSource.callTool(name, args, { signal })           │
  │      ▼  (just awaits a promise — knows nothing about rate limits)  │
  │  port: DataSource (lib/data-source/types.ts)                       │
  └────────────────────────────┬──────────────────────────────────────┘
                               │
  ┌─ ★ ADAPTER (Bloomreach) ★ ▼──────────────────────────────────────┐ ← we are here
  │  BloomreachDataSource (lib/data-source/bloomreach-data-source.ts) │
  │   ┌─────────────────────────────────────────────────────────────┐ │
  │   │ 1. cache check (60s TTL, name+args key)        ← absorbs    │ │
  │   │ 2. proactive spacing (≥1.1s since last call)   ← prevents   │ │
  │   │ 3. liveCall via transport                                    │ │
  │   │ 4. rate-limit retry ladder (up to 3x)          ← recovers   │ │
  │   │ 5. cache write (skip on error)                 ← preserves  │ │
  │   └─────────────────────────────────────────────────────────────┘ │
  └────────────────────────────┬──────────────────────────────────────┘
                               │  HTTPS
  ┌─ Provider ────────────────▼──────────────────────────────────────┐
  │  loomi-mcp-alpha.bloomreach.com/mcp                                │
  │  per-user global rate limit: ~1 req/s, sometimes 1 per 10s         │
  │  alpha-grade: revokes tokens after minutes, two error envelopes    │
  └─────────────────────────────────────────────────────────────────────┘
```

## Structure pass

Three layers carry this pattern: the **caller** layer (agents calling `callTool`), the **adapter** layer (the five-step `callTool` body), the **provider** layer (the rate-limited upstream). One axis worth tracing: **what does each layer believe about the rate limit?**

```
  Axis: what does each layer believe about the rate limit?

  ┌─ caller ─────────────────────┐    "rate limits don't exist"
  │  agents await callTool       │   ═════╪═════►
  │  treat result as immediate   │
  └──────────────────────────────┘
       ┌─ adapter ─────────────────┐    "rate limits are my job"
       │  cache → space → call →   │
       │  retry → cache-write      │   ═════╪═════►
       └────────────────────────────┘
            ┌─ provider ────────────┐    "1 req/s per user, globally"
            │  enforces, states     │
            │  window in error text │
            └────────────────────────┘
```

The seam is the port (`DataSource`). Above it, the rate limit is *abstracted away* — the agent treats `callTool` as "make this happen." Below it, the rate limit is *enforced* — the upstream returns rate-limit errors with a stated penalty window. The adapter is the translator: it absorbs the enforcement and presents the abstraction. → see `03-datasource-seam.md` for the port itself.

## How it works

### Move 1 — the mental model

You've used a `fetch` with a retry-on-failure helper. The helper wraps the fetch, catches network errors, waits, retries. The user of the helper just calls `await fetchWithRetry(url)` and treats the result as immediate. Reliability is concentrated in the helper; the caller's code stays clean.

The Bloomreach adapter is a fetch-with-retry that also (a) proactively spaces calls to stay under the rate limit, (b) parses the server's stated penalty window from the error text instead of guessing, (c) caches successful results for 60s so repeated identical calls don't even hit the network. Five steps inside one method; one promise out.

```
  The pattern: five-step callTool — cache, space, call, retry, cache-write

  callTool(name, args, { signal }):
    1. CACHE CHECK     hash(name+args) in cache & not expired → return cached
    2. PROACTIVE SPACE wait until ≥1.1s since lastCallAt
    3. LIVE CALL       transport.callTool(...) — may throw or return isError
    4. RETRY LADDER    while isRateLimited(result) && retries < 3:
                         waitMs = parseRetryAfter(result) + 500ms buffer
                                   OR exponential backoff
                                   capped at retryCeilingMs (20s)
                         sleep(waitMs); liveCall(...) again
    5. CACHE WRITE     if !isError → cache.set(key, {result, expiresAt})
                       return { result, durationMs, fromCache: false }
```

### Move 2 — the step-by-step walkthrough

#### the five-step `callTool` — the whole pattern in one method

```ts
// lib/data-source/bloomreach-data-source.ts:139-188
async callTool<T = unknown>(
  name: string,
  args: Record<string, unknown>,
  options: CallToolOptions = {},
): Promise<CallToolResult<T>> {
  const cacheKey = `${name}:${JSON.stringify(args)}`;
  const ttl = options.cacheTtlMs ?? 60_000;

  // 1. CACHE CHECK
  if (!options.skipCache) {
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { result: cached.result as T, durationMs: 0, fromCache: true };
    }
  }

  // 2 + 3. PROACTIVE SPACE + LIVE CALL (inside liveCall)
  const start = Date.now();
  let result = await this.liveCall(name, args, options.signal);

  // 4. RETRY LADDER
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

  const durationMs = Date.now() - start;

  // 5. CACHE WRITE (skip on error)
  if ((result as any)?.isError === true) {
    return { result: result as T, durationMs, fromCache: false };
  }
  const now = Date.now();
  this.cache.set(cacheKey, { result, expiresAt: now + ttl });
  return { result: result as T, durationMs, fromCache: false };
}
```

Five steps, each addressing one upstream reality. Below, each step in detail.

#### step 1 — the cache check (absorbs the common case)

```ts
// lib/data-source/bloomreach-data-source.ts:144-152
const cacheKey = `${name}:${JSON.stringify(args)}`;
const ttl = options.cacheTtlMs ?? 60_000;

if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

The key is `name + JSON.stringify(args)` — identical calls hit. The TTL defaults to 60s. The cache is per-adapter-instance, so it lives as long as the connection does. Cache hits return `fromCache: true` with `durationMs: 0`, surfaced to the trace panel so a user can see when a card came from cache.

The cache is bypassable per call via `options.skipCache` — the four short MCP routes (`/api/mcp/{call,tools,tools/check,capture}`) use this for the dev "force fresh" path. The bypass writes through: a `skipCache` call still updates the cache on success (this is the desired behavior — dev tools see fresh data; the next agent call doesn't pay for it again).

```
  Pattern — the cache is a write-through, time-bounded Map

  Map<"toolName:{args}", { result, expiresAt }>
    get:    return if expiresAt > now
    set:    on every successful (non-error) call
    bypass: skipCache=true skips read, still writes (write-through)
    TTL:    60s default, per-call override via cacheTtlMs

  errors are NEVER cached (cache poisoning protection — step 5)
```

#### step 2 — proactive spacing (prevents the rate limit before it hits)

`liveCall` is the wrapper that adds the spacing:

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

Three observations on the spacing:

- **`minIntervalMs = 1100`** (set in `lib/mcp/connect.ts:96-100`). The Bloomreach server states its window as "1 per 1 second" or sometimes "1 per 10 second" — 1.1s gives 100ms of headroom against the 1s window and prevents the first rate-limit hit in the common case.
- **`lastCallAt` is updated on both success and failure.** A failed call still counted against the upstream's window; spacing the next call against it is the right thing.
- **Spacing at the *full* 10s window would blow the budget.** The header comment in `connect.ts:86-93` explains: "spacing at the full 10s window would cost ~60s for a 6-call investigation and blow the route's 60s budget." So 1.1s is the right floor; the retry ladder (step 4) handles the worse case when the upstream is actively rate-limiting.

```
  Execution trace — proactive spacing in action

  state: lastCallAt = 0

  callTool('eql', { … }, {signal})
    elapsed = now - 0 = (huge)
    spacing wait: 0ms (first call)
    transport.callTool → result in 380ms
    lastCallAt = now

  callTool('eql', { … other args }, {signal})  ← 50ms after previous
    elapsed = now - lastCallAt = 50ms
    spacing wait: 1100 - 50 = 1050ms
    transport.callTool → result in 290ms
    lastCallAt = now

  callTool('eql', { … same args as 1st }, {signal})  ← cache hit
    cache.get(key) → fresh entry → return immediately, fromCache: true
    NO spacing wait, NO transport call
```

#### step 3 — the live call (and its error envelope)

The transport call itself can return two kinds of "this didn't work":

- **A *thrown* error.** Network failure, transport-level 401, etc. The adapter catches, wraps in `McpToolError` (with the tool name and the server detail), rethrows.
- **A *returned* result with `isError: true`.** The MCP protocol uses an error envelope that travels in the success channel. Rate-limit errors come back this way — the call succeeded at the HTTP layer, but the result is `{ isError: true, content: [{ type: 'text', text: 'rate limit reached (1 per 10 second)' }] }`. The adapter inspects the returned result to detect this.

```ts
// lib/data-source/bloomreach-data-source.ts:51-55
function isRateLimited(result: unknown): boolean {
  if (!result || typeof result !== 'object' || (result as any).isError !== true) return false;
  const text = JSON.stringify((result as any).content ?? result);
  return /rate limit|too many requests/i.test(text);
}
```

A returned `isError` with rate-limit text triggers the retry ladder (step 4). A returned `isError` *without* rate-limit text is a real tool failure (the agent gets the error envelope and either tries a different approach or synthesizes "I couldn't get that data"). The error envelope is *never cached* (step 5).

#### step 4 — the retry ladder (recovers from rate limits)

```ts
// lib/data-source/bloomreach-data-source.ts:163-174
let retries = 0;
while (isRateLimited(result) && retries < this.maxRetries) {
  retries++;
  const hintMs = parseRetryAfterMs(result);                       // ← parse server's stated window
  const backoffMs = this.retryDelayMs * 2 ** (retries - 1);       // ← exponential backoff fallback
  const waitMs = Math.min(
    hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,
    this.retryCeilingMs,                                          // ← 20s ceiling
  );
  await sleep(waitMs);
  result = await this.liveCall(name, args, options.signal);
}
```

The ladder is *informed* by the upstream's error text. `parseRetryAfterMs` (`bloomreach-data-source.ts:64-71`) handles both observed shapes:

```ts
function parseRetryAfterMs(result: unknown): number | null {
  const text = JSON.stringify((result as any)?.content ?? result);
  const after = text.match(/retry[\s-]*after[^0-9]*(\d+)\s*second/i);
  if (after) return parseInt(after[1], 10) * 1000;                // "Retry after ~12 second(s)" → 12000
  const perWindow = text.match(/per\s*(\d+)\s*second/i);
  if (perWindow) return parseInt(perWindow[1], 10) * 1000;        // "1 per 10 second" → 10000
  return null;
}
```

Two shapes parsed; either yields the right ms. When neither matches, the ladder falls back to exponential backoff (`retryDelayMs * 2^(retries-1)` — 10s, 20s, 40s, capped at 20s by `retryCeilingMs`). The 500ms `RETRY_BUFFER_MS` cushion lands the retry *just after* the penalty clears instead of on its boundary.

```
  Execution trace — three retries against a 10s penalty window

  call 1: liveCall → result.isError + text "1 per 10 second"
    isRateLimited = true; retries = 0

  RETRY 1:
    retries = 1
    hintMs = parseRetryAfterMs → 10000
    backoffMs = 10000 * 2^0 = 10000
    waitMs = min(10000 + 500, 20000) = 10500
    sleep(10500)
    liveCall → result.isError again

  RETRY 2:
    retries = 2
    hintMs = 10000; backoffMs = 20000
    waitMs = min(10500, 20000) = 10500
    sleep(10500)
    liveCall → success

  return { result, durationMs ≈ 21500, fromCache: false }
```

The ladder is `maxRetries = 3` by default — three retries × ~10s = ~30s budget burned, which is half the route's 60s ceiling on the agent route. Raising `maxRetries` further would risk a single bad call eating the entire budget; lowering it would surface more rate-limit failures to the agent.

#### step 5 — cache write (preserves correctness)

```ts
// lib/data-source/bloomreach-data-source.ts:178-188
if ((result as any)?.isError === true) {
  return { result: result as T, durationMs, fromCache: false };
}
const now = Date.now();
this.cache.set(cacheKey, { result, expiresAt: now + ttl });
return { result: result as T, durationMs, fromCache: false };
```

Two pieces:

- **Errors are not cached.** The check at the top of step 5 short-circuits before any `cache.set`. A transient upstream 5xx, a rate-limit failure that gave up after 3 retries, a malformed tool call — none of them poison the cache. The next caller pays for a fresh attempt, which is the right semantics.
- **`skipCache` still writes.** Notice the absence of `if (!options.skipCache)` around the `cache.set`. A `skipCache` call bypasses the read (step 1) but still writes the result on success. This is the "write-through" behavior the comment at line 183-184 calls out — the dev `/api/mcp/call` path forces a fresh fetch, but the cache update means the next agent doesn't pay for it again.

#### the AbortSignal thread — cancellation reaches network

The `signal` parameter is threaded through every layer:

```ts
// lib/data-source/bloomreach-data-source.ts:155 + 196
let result = await this.liveCall(name, args, options.signal);
…
const result = await this.transport.callTool(name, args, { signal });
```

The signal originates as `req.signal` in the route, threads into `dataSource.callTool({ signal })`, into `this.liveCall(..., signal)`, into `this.transport.callTool(..., { signal })` — which is the MCP SDK's transport, which forwards to `fetch({ signal })`. A browser tab close aborts the whole chain in milliseconds.

What the signal does *not* abort: the retry-ladder's `sleep()`. If the abort fires during the sleep, the sleep still completes its full duration before the next iteration checks the signal. This is a known small leak — the ladder is at most 20s × 3 = 60s of sleep total, and the next `liveCall` will see the signal aborted and throw. In practice the abort is responsive enough; if it ever needed to be faster, the `sleep` could be made signal-aware (`Promise.race([sleep(ms), abort.signal])`).

```
  Layers-and-hops — the cancel chain through the adapter

  ┌─ route ─────────────────┐  hop A: dataSource.callTool(name, args, {signal: req.signal})
  │  /api/briefing          │ ────────────────────────────────────────────────────────────►
  └─────────────────────────┘                                                              ┌─ BloomreachDataSource ───┐
                                                                                            │  callTool {opts.signal}   │
                                                                                            │   ↓                       │
                                                                                            │  liveCall(name, args, sig)│
                                                                                            └───────────┬───────────────┘
                                                                                                        │ hop B: transport.callTool(..., {signal})
                                                                                                        ▼
                                                                                            ┌─ McpTransport ───────────┐
                                                                                            │  StreamableHTTPClient…    │
                                                                                            └───────────┬───────────────┘
                                                                                                        │ hop C: fetch(url, {signal})
                                                                                                        ▼
                                                                                                  network — abort fires
```

### Move 3 — the principle

When an upstream is rate-limited *and* the rate limit is per-user-global *and* the rate limit is severe, the reliability mechanic belongs at the *one place that owns the upstream connection*. That's the adapter, not the agent and not the route. The adapter is what turns "the upstream is unreliable" into "the port behaves like a normal `await` for callers." Concentrating the mechanic in one file (this one, 214 LOC) means there's exactly one place to tune the spacing, exactly one place to add a new error-envelope shape, exactly one place to audit reliability behavior. Five steps in one method is denser than spreading the same logic across the agent loop and the route, but the density is the point — every reliability question has one answer location.

The transferable lesson: rate-limit handling has *three* tools, and you usually need all three. (1) Proactive spacing prevents most hits before they happen. (2) Retry-with-server-hints recovers from the hits you can't prevent. (3) Caching absorbs the repeated calls that don't need to hit the network at all. Picking one and skipping the others leaves a known gap — pure spacing wastes budget on cache-hittable calls; pure retry burns latency on calls that could have been spaced; pure cache fails when the upstream actually rate-limits a fresh call. The right shape is the layered one this adapter uses.

## Primary diagram

```
  rate-limit-aware-mcp-client — full picture

  ┌─ Caller (agents) ─────────────────────────────────────────────────────┐
  │                                                                        │
  │  monitoring / diagnostic / recommendation / query agents               │
  │     await dataSource.callTool(name, args, { signal })                  │
  │     (knows nothing about cache, spacing, retry)                        │
  └────────────────────────────┬──────────────────────────────────────────┘
                               │  port: DataSource.callTool
  ┌─ Adapter: BloomreachDataSource (lib/data-source/bloomreach-data-source.ts) ┐
  │                                                                            │
  │  Internal state per instance:                                              │
  │    cache:        Map<"name:{args}", { result, expiresAt }>                  │
  │    lastCallAt:   number (timestamp of last completed call)                  │
  │    minIntervalMs:        1100  (proactive spacing floor)                    │
  │    maxRetries:           3                                                  │
  │    retryDelayMs:         10_000 (fallback backoff base)                     │
  │    retryCeilingMs:       20_000 (cap on any single wait)                    │
  │    RETRY_BUFFER_MS:      500   (cushion past server's stated window)        │
  │                                                                            │
  │  callTool(name, args, { signal, skipCache?, cacheTtlMs? }):                │
  │    ① cacheKey = name + JSON.stringify(args); ttl = cacheTtlMs ?? 60_000     │
  │    ① if !skipCache && cache fresh → return cached, fromCache: true          │
  │    ② + ③ liveCall(name, args, signal):                                      │
  │           wait until ≥ minIntervalMs since lastCallAt                       │
  │           transport.callTool(name, args, { signal })                        │
  │           update lastCallAt (on success OR failure)                         │
  │           on throw: wrap in McpToolError, rethrow                           │
  │    ④ while isRateLimited(result) && retries < maxRetries:                   │
  │           hintMs   = parseRetryAfterMs(result)                              │
  │           backoff  = retryDelayMs * 2^(retries-1)                           │
  │           waitMs   = min(hintMs != null ? hintMs + 500 : backoff, ceiling)  │
  │           sleep(waitMs); liveCall again                                     │
  │    ⑤ if result.isError → return { result, durationMs, fromCache: false }    │
  │       else cache.set(key, { result, expiresAt: now+ttl }); return same      │
  │                                                                            │
  │  Bloomreach-specific extras (on the concrete class, NOT on the port):      │
  │    options.skipCache    — used by /api/mcp/{call,tools,tools/check,capture}│
  │    options.cacheTtlMs   — per-call TTL override                            │
  │    ConnectResult.mcp typed as BloomreachDataSource (deliberate breach)     │
  └────────────────────────────┬──────────────────────────────────────────────┘
                               │  HTTPS (StreamableHTTPClientTransport)
  ┌─ Provider ────────────────▼──────────────────────────────────────────────┐
  │  loomi-mcp-alpha.bloomreach.com/mcp                                       │
  │  per-user global rate limit, ~1 req/s sometimes 1 per 10s                 │
  │  states the window in error text (two shapes parsed):                     │
  │    "Retry after ~12 second(s)"   → 12s                                    │
  │    "1 per 10 second"             → 10s                                    │
  │  alpha-grade: tokens revoke after minutes (handled separately by         │
  │  useReconnectPolicy on the browser side — see 02-auth-boundary.md)       │
  └─────────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Why not a token bucket library.** A formal token bucket would model the upstream's allowance as N tokens replenished at rate R. The Bloomreach upstream's "1 per 1 second sometimes 1 per 10 second" doesn't fit cleanly — the bucket's rate would have to change based on the upstream's mood. The shape we have — fixed proactive spacing + reactive retry that reads the server's stated window — handles both regimes without requiring the client to know which one the server is in right now. It's less elegant but more correct for a rate limit that varies.

**Why the cache key is `name + JSON.stringify(args)`.** The naive choice would be a structural hash. `JSON.stringify` works because the agent's tool calls have stable argument shapes (the EQL is a string; the date range is a string; the project_id is a string). The risk is argument-order sensitivity in objects (`{a:1, b:2}` vs `{b:2, a:1}` stringify differently), but the agent doesn't randomize argument order across calls, so it's fine in practice. A structural hash would be more robust at the cost of complexity.

**Why 60s cache TTL.** The briefing scan runs ~10 categories with ~6 tool calls each in roughly 30-60s of wall-clock. A 60s TTL is enough that a repeated call within the same scan hits, but short enough that two consecutive briefings don't see stale data. The TTL is per-call overridable via `cacheTtlMs` for paths that want different semantics (the `/api/mcp/capture` route uses a longer TTL during dev capture).

**Why error envelopes are never cached.** A rate-limit error or a transient 5xx is *not the truth about the upstream right now* — it's a snapshot of an unhealthy moment. Caching it would make the next caller pay for a 60-second window of pretending the upstream is unhealthy when it might recover in 200ms. The right semantics: cache the *successful* answer; let the next call discover the upstream's current state. The `(result as any)?.isError === true` check at line 179 is the load-bearing piece.

**The cancel-during-sleep small leak.** When the route's `req.signal` fires during the retry ladder's `sleep(waitMs)`, the sleep completes its full duration before the next `liveCall` notices. The worst case is 20s of wasted wait before the abort propagates. This is an acceptable small leak because (a) the abort eventually fires, (b) no further upstream work happens, (c) the route's `finally` still runs to log the partial budget. A signal-aware sleep (`Promise.race([sleep(ms), abortSignal])`) would close the gap if needed; it isn't a current pain point.

## Interview defense

**Q: Walk me through how `callTool` handles a rate-limit error.**

> Five steps in one method. (1) Hash the call to a cache key (`name + JSON.stringify(args)`); if `skipCache` isn't set and the cache has a fresh entry, return it with `fromCache: true` and zero duration. (2) Inside `liveCall`, wait until at least 1.1 seconds have passed since the last call (proactive spacing against the upstream's 1 req/s window). (3) Call `transport.callTool`; the MCP SDK does the HTTPS via `StreamableHTTPClientTransport`. (4) Inspect the result — if `isError: true` and the text matches rate-limit patterns (`/rate limit|too many requests/i`), parse the server's stated window (`"1 per 10 second"` → 10000ms, `"Retry after ~12 second(s)"` → 12000ms), sleep that long plus a 500ms buffer, retry. Up to three retries with a 20s ceiling per wait. (5) On success, write the result to the cache; on error, skip the cache write so we don't poison it. Return `{ result, durationMs, fromCache: false }`. The agent above never sees any of this — it just awaits one promise.

```
  the five steps

  ① cache check       (absorbs)
  ② proactive space   (prevents)
  ③ live call         (the work)
  ④ retry ladder      (recovers, server-hint-aware)
  ⑤ cache write       (preserves — errors never cached)
```

**Anchor:** `lib/data-source/bloomreach-data-source.ts:139-188`.

**Q: Why are errors never cached?**

> Because an error isn't "the truth about the upstream right now" — it's a snapshot of an unhealthy moment that may resolve in 200ms. Caching it for 60 seconds would make the next caller pay for a full minute of pretending the upstream is unhealthy when it might already have recovered. The check `if ((result as any)?.isError === true) return { result, durationMs, fromCache: false }` at line 179 short-circuits before any `cache.set`. The right semantics: cache *successful* answers; let the next call discover the upstream's current state. The same logic applies to rate-limit failures that exhausted retries — they come back as errors, not cached, and the next call gets a fresh attempt.

```
  cache policy by outcome

  success      → cache.set(key, { result, expiresAt: now+60s })
  isError      → return without caching   ← prevents poisoning
  thrown       → wrap in McpToolError, rethrow, no cache update
```

**Anchor:** `lib/data-source/bloomreach-data-source.ts:178-181`.

**Q: What's the load-bearing kernel of this adapter — what's the minimum that's still the pattern?**

> Three pieces. The proactive spacing (the `await` on `minIntervalMs - elapsed` before each live call), the rate-limit detection (`isRateLimited(result)` checking the error envelope text), and the server-hint-aware retry wait (`parseRetryAfterMs(result)` extracting the stated window from the error text). Strip any one of those and the adapter fails differently. No spacing → every burst hits the rate limit on the first call; no detection → rate-limit errors pass through as if they were real tool failures and the agent gives up; no server-hint parsing → the retry wait either guesses too short (next attempt also hits the window) or too long (burns budget). The cache and the `AbortSignal` threading are hardening — important, but they don't define the pattern; the spacing-detect-hint triad does.

```
  the kernel

  ① proactive spacing       → 1.1s floor before each live call
  ② rate-limit detection    → /rate limit|too many requests/i on isError text
  ③ server-hint retry wait  → parseRetryAfterMs → hint+500ms, ceiling 20s

  hardening (not the kernel):
    cache, AbortSignal thread, McpToolError wrap, write-through skipCache
```

**Anchor:** `lib/data-source/bloomreach-data-source.ts:51-71, 163-174, 190-205`.

## See also

- `03-datasource-seam.md` — the port this adapter implements
- `02-auth-boundary.md` — the other half of upstream reliability (token revocation handled in the UI)
- `01-request-flow.md` — where `dataSource.callTool` is called from inside the agent scan
- `04-aptkit-primitive-boundary.md` — the `BloomingToolRegistryAdapter` that forwards the library's `callTool` to this adapter

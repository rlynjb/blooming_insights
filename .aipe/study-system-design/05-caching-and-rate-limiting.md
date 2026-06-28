# Caching and rate limiting — surviving a ~1 req/s alpha provider

**Industry name:** client-side cache + token-bucket-style proactive spacing + server-stated retry-after backoff · Industry standard

## Zoom out, then zoom in

The Bloomreach loomi connect alpha rate-limits each authenticated user
globally at roughly one request per second. A multi-agent investigation
can run 6-8 tool calls; naively, that's 6-8 seconds of forced waits
embedded in our 300-second route ceiling. We absorb the constraint with
three layered defences inside one class: a 60-second response cache, a
proactive ~1.1s inter-call spacer, and a retry ladder that parses the
server's stated penalty window from the error envelope.

You know how `fetch` doesn't automatically retry on a 429 — you'd write
the retry yourself. Same shape here, but the retry "after" value isn't
in a `Retry-After` header; it's embedded in the error envelope text
(`"rate limit reached (1 per 10 second)"`). We parse it out.

```
  Zoom out — where caching + rate-limiting live

  ┌─ Service ────────────────────────────────────────────────────────────┐
  │  agent loop                                                           │
  │       │                                                               │
  │       ▼                                                               │
  │  dataSource.callTool('execute_analytics_eql', { eql, project_id })    │
  │       │                                                               │
  │       ▼                                                               │
  │  ┌─ BloomreachDataSource ─────────────────────────────────────────┐   │
  │  │  ★ 60s cache lookup ★                                          │   │ ← we are here
  │  │  ★ ~1.1s inter-call spacing (sleep) ★                          │   │
  │  │  ★ rate-limit retry ladder (parse stated window) ★             │   │
  │  └────────────────────────────────────┬───────────────────────────┘   │
  │                                        │                              │
  └────────────────────────────────────────┼──────────────────────────────┘
                                           │ HTTPS (Bearer)
                                           ▼
                              ┌─ Bloomreach loomi connect ─┐
                              │  ~1 req/s per user, global │
                              │  states penalty window in   │
                              │  error envelope text        │
                              └────────────────────────────┘
```

This is a "live inside the rate limit" pattern, not an "avoid the rate
limit" pattern. The defences are layered: cache absorbs repeats, spacing
keeps us under the line on the steady state, retry recovers when we
overrun anyway.

## Structure pass — layers, axis, seams

**Layers:** Agent → DataSource.callTool → cache check → live call →
spacing → MCP transport → Bloomreach.

**Axis (held constant): "what's the cost of this request, in seconds?"**

```
  Axis: how long does one callTool() actually take?

  ┌─ cache hit ────────────────────────────────────────────────┐
  │  return immediately                              ~0 ms      │
  └────────────────────────────────────────────────────────────┘

  ┌─ cache miss, fresh window ─────────────────────────────────┐
  │  sleep(minIntervalMs - elapsed) + transport call            │
  │  ~ 0 to 1100ms wait + actual HTTPS round-trip (~200-800ms)  │
  └────────────────────────────────────────────────────────────┘

  ┌─ cache miss, rate-limited ─────────────────────────────────┐
  │  spacing + transport call → 429 → parse window (~10s) →    │
  │  sleep(10s + 500ms buffer) → transport call again          │
  │  repeat up to maxRetries (3) or until success              │
  │  ~ 10s × retries + final call                              │
  └────────────────────────────────────────────────────────────┘

  ┌─ transport timeout ────────────────────────────────────────┐
  │  any single call > 30s → AbortSignal.timeout fires →       │
  │  throws "HTTP 0: timeout after 30000ms"                    │
  │  not retried — fails fast inside the route budget          │
  └────────────────────────────────────────────────────────────┘
```

The axis isn't just informational — it's what drove every threshold
choice. `minIntervalMs: 1100` keeps the steady state below 1 req/s.
`retryDelayMs: 10_000` matches the observed 10s penalty window.
`retryCeilingMs: 20_000` caps any single wait. `maxRetries: 3` caps
total retry cost at ~30s on one call so a single bad call can't blow
the route budget.

**Seams (boundaries where the cost answer flips):**

- **Cache layer ↔ live call** — 0ms vs 200-800ms + maybe seconds. The
  cache hides one decision (was this exact `name:argsJson` seen in the
  last 60s?) and changes the cost story completely.
- **Spacing layer ↔ transport** — 0-1100ms vs actual HTTPS time. The
  spacer is a sleep; if we just made a call <1.1s ago, we wait the
  difference before issuing the next one.
- **Retry layer ↔ transport** — 0 retries vs up to 3 × 10s. Triggered
  only by *successful-but-rate-limited* tool results — the body returns
  `isError: true` with rate-limit text. Transport-level failures (401,
  timeouts) don't retry.

## How it works

### Move 1 — the mental model

The shape is three nested boxes around the actual HTTPS call.

```
  Pattern — three defences, layered

  ┌─ defence 1: cache (60s) ────────────────────────────────────────┐
  │  if key in cache and not expired:  return cached                │
  │                                                                  │
  │  ┌─ defence 2: spacing (~1.1s) ──────────────────────────────┐  │
  │  │  if (now - lastCallAt) < minIntervalMs:                   │  │
  │  │    await sleep(minIntervalMs - elapsed)                   │  │
  │  │                                                            │  │
  │  │  ┌─ defence 3: retry ladder ──────────────────────────┐   │  │
  │  │  │  result = await transport.callTool(...)             │   │  │
  │  │  │  while isRateLimited(result) and retries < max:    │   │  │
  │  │  │    waitMs = parseRetryAfterMs(result)              │   │  │
  │  │  │             ?? backoff(retryDelayMs, retries)      │   │  │
  │  │  │    waitMs = min(waitMs, retryCeilingMs)             │   │  │
  │  │  │    await sleep(waitMs); retries += 1               │   │  │
  │  │  │    result = await transport.callTool(...)           │   │  │
  │  │  │  return result                                      │   │  │
  │  │  └────────────────────────────────────────────────────┘   │  │
  │  └───────────────────────────────────────────────────────────┘  │
  │                                                                  │
  │  cache[key] = result (only if !isError)                          │
  └─────────────────────────────────────────────────────────────────┘
```

What's load-bearing: each defence handles a different failure mode.
Strip any one and you fail in a different way (more on this in
Interview defense).

### Move 2 — the step-by-step walkthrough

#### Step 1 — the cache (60s, per `name:argsJson` key)

The cache is the cheapest defence. A `Map<string, {result, expiresAt}>`
keyed by `tool-name:JSON.stringify(args)`.

```typescript
// lib/data-source/bloomreach-data-source.ts:139-152
async callTool<T = unknown>(
  name: string, args: Record<string, unknown>,
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
  // ... live call path below
}
```

Two real-world hits this absorbs:

  → the agent loop can call the same tool repeatedly with the same args
    when reasoning across turns (sanity-checking, "let me recompute X")
  → the bootstrap schema cache (`lib/mcp/schema.ts:138`) holds the
    workspace schema for the whole instance, but each of the 4 bootstrap
    calls is cached at THIS level too — so a cold instance pays once,
    re-bootstraps hit the cache

Don't cache errors (`bloomreach-data-source.ts:179-181`):

```typescript
if ((result as any)?.isError === true) {
  return { result: result as T, durationMs, fromCache: false };
}
```

This matters because a 401 must NOT poison the cache. If we cached
errors, a single auth blip would pin every subsequent call to "error"
for 60s — far worse than just retrying live.

#### Step 2 — the proactive spacer (~1.1s)

Bloomreach's rate limit is per-user globally. The spacer's job: don't
let our own concurrent code burn through the budget faster than the
server allows.

```typescript
// lib/data-source/bloomreach-data-source.ts:190-205
private async liveCall(name, args, signal): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  try {
    const result = await this.transport.callTool(name, args, { signal });
    this.lastCallAt = Date.now();
    return result;
  } catch (err) {
    this.lastCallAt = Date.now();   // still update — failed calls still hit the budget
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}
```

Note `this.lastCallAt = Date.now()` is set in BOTH success and error
paths. A failed call still consumed the per-user budget; we have to
record that or the next call will fire immediately and 429.

**The threshold choice** (`lib/mcp/connect.ts:97`):

```typescript
return { ok: true,
         mcp: new BloomreachDataSource(new SdkTransport(client, httpErrors), {
           minIntervalMs: 1100,
           retryDelayMs: 10_000,
           retryCeilingMs: 20_000,
           maxRetries: 3,
         }) };
```

`minIntervalMs: 1100` is 1.1 seconds, not 10. The comment at
`connect.ts:86-100` explains: spacing at the full 10s window would cost
~60s for a 6-call investigation and blow the 60s budget (the comment is
stale — it now references the legacy 60s Hobby ceiling, not the 300s
Pro one we use today). The bet: the steady state is ~1 req/s, so 1.1s
is safe; the occasional 10s penalty is handled by the retry ladder.

#### Step 3 — the retry ladder

When a call comes back with a rate-limit shape, the ladder waits the
server-stated window and tries again, capped at `maxRetries`.

```typescript
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

`isRateLimited` matches both observed Bloomreach error shapes
(`bloomreach-data-source.ts:51-55`):

```typescript
function isRateLimited(result: unknown): boolean {
  if (!result || typeof result !== 'object' || (result as any).isError !== true) return false;
  const text = JSON.stringify((result as any).content ?? result);
  return /rate limit|too many requests/i.test(text);
}
```

`parseRetryAfterMs` extracts the stated window from two observed
shapes (`bloomreach-data-source.ts:64-71`):

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

Why `RETRY_BUFFER_MS = 500`: the server's stated "retry after 10 seconds"
isn't an exact promise — landing the retry at exactly the boundary risks
hitting the penalty window again. 500ms cushion puts us just past it.

```
  Execution trace — one rate-limited tool call

  state                                    value
  ─────                                    ─────
  t=0       result = await liveCall(...)   → { isError: true, content: "rate limit reached (1 per 10 second)" }
  t=10ms    isRateLimited(result)          → true
  t=10ms    parseRetryAfterMs(result)      → 10_000
  t=10ms    waitMs = min(10_500, 20_000)   → 10_500
  t=10510   result = await liveCall(...)   → { isError: false, content: {...real data...} }
  t=10510   isRateLimited(result)          → false   (loop exits)
  t=10510   return { result, durationMs:10510, fromCache:false }
```

#### Step 4 — the transport-level timeout (the fourth defence)

Below the BloomreachDataSource sits `SdkTransport`
(`lib/mcp/transport.ts:123-165`), which adds a per-call 30s timeout via
`AbortSignal` composition:

```typescript
// lib/mcp/transport.ts:129-146 (abridged)
async callTool(name, args, opts?): Promise<unknown> {
  if (this.httpErrors) this.httpErrors.last = null;
  const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
  try {
    return await this.client.callTool({ name, arguments: args }, undefined, { signal });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`HTTP 0: timeout after ${TOOL_TIMEOUT_MS}ms`, { cause: err });
    }
    // ... captured-body path
  }
}
```

`composeSignals` (`transport.ts:173-189`) ORs the client-cancel signal
with the per-call timeout — whichever fires first wins. The timeout is
NOT retried by the ladder (it throws), so a stuck call fails fast
instead of burning the route budget.

```
  The four defences, ordered by where they live

  ┌─ BloomreachDataSource ─────────────────────────────────────┐
  │  defence 1: 60s cache       hides repeats                   │
  │  defence 2: 1.1s spacer     paces the steady state          │
  │  defence 3: retry ladder    recovers from 429              │
  └────────────────────────────────────────────────────────────┘
  ┌─ SdkTransport ─────────────────────────────────────────────┐
  │  defence 4: 30s timeout     bounds any single call         │
  └────────────────────────────────────────────────────────────┘
```

#### Step 5 — what the four short MCP routes do differently

The dev-tooling routes (`/api/mcp/{call,reset,capture,capture-demo}`)
need to force-fresh some calls — the `/debug` page is exactly the
place where stale cache is wrong. They use the concrete
`BloomreachDataSource` (not the abstract `DataSource`) so they can
pass `skipCache: true`:

```typescript
// app/api/mcp/call/route.ts:33
const r = await conn.mcp.callTool(name, args ?? {}, { skipCache: true });
```

`skipCache` still WRITES to the cache after the call (it's a
write-through, not a write-around). The comment in
`bloomreach-data-source.ts:183-187`: "a skipCache call still refreshes
the cache." The desired behavior — force fresh, but populate for next
time.

### Move 3 — the principle

**Layer your defences in order of cost.** Cheapest first: cache check
is O(1). Next: a sleep that maybe runs (spacer). Next: retry with
backoff (only on the rate-limited path). Last: timeout (only on the
stuck-call path). Each defence handles one specific failure mode; each
runs only when the cheaper ones didn't apply.

The general principle: when a dependency is constrained on multiple
axes (rate, latency, reliability), don't try to solve it with one
defence. Identify the axes, pick a defence per axis, layer them in
order of cost. The code reads as a clear sequence of "is this the
easy case → return; is it the spacing case → sleep; is it the retry
case → loop." Each conditional is one line; the structure is the
algorithm.

## Primary diagram

```
  Caching + rate-limiting — one full callTool() round-trip

  ┌─ agent ─────────────────────────────────────────────────────────────────┐
  │  dataSource.callTool('execute_analytics_eql', { eql, project_id })       │
  └──────────────────────────────┬──────────────────────────────────────────┘
                                 │
  ┌─ BloomreachDataSource.callTool ─────────────────────────────────────────┐
  │  cacheKey = `${name}:${JSON.stringify(args)}`                            │
  │                                                                           │
  │  if (!skipCache && cache.has(key) && !expired):                          │
  │     ──────►  return { result: cached, durationMs: 0, fromCache: true }   │
  │                                                                           │
  │  liveCall(name, args, signal):                                            │
  │    elapsed = now - lastCallAt                                             │
  │    if elapsed < 1100ms:                                                   │
  │       sleep(1100 - elapsed)                                               │
  │    SdkTransport.callTool(...)                                             │
  │       │                                                                   │
  │       └───►  composeSignals(opts.signal, AbortSignal.timeout(30s))        │
  │             client.callTool(...)                                          │
  │                  → result (success)  OR  → throw (timeout / 4xx / 5xx)    │
  │    lastCallAt = now                                                       │
  │                                                                           │
  │  while isRateLimited(result) && retries < 3:                              │
  │    waitMs = parseRetryAfterMs(result) ?? (10_000 * 2**(retries-1))       │
  │    waitMs = min(waitMs + 500, 20_000)                                     │
  │    sleep(waitMs)                                                          │
  │    result = liveCall(name, args, signal)   ← honors spacer + timeout      │
  │    retries++                                                              │
  │                                                                           │
  │  if isError(result): return without caching                              │
  │  cache.set(key, { result, expiresAt: now + 60_000 })                     │
  │  return { result, durationMs, fromCache: false }                         │
  └──────────────────────────────┬──────────────────────────────────────────┘
                                 │
                                 ▼
                          back to the agent
```

## Elaborate

**Where this pattern comes from.** Three classical patterns layered:

  → response cache → standard memoization with TTL
  → proactive spacing → simplification of token-bucket rate limiting
    where the bucket size is 1 and the refill rate is `1/minIntervalMs`
  → retry on rate-limited response → exponential backoff with
    server-stated hint (the modern AWS SDK / Stripe SDK shape)

The combination is the working AI-engineer shape for "production agent
talking to a rate-limited provider." None of the three is novel; the
load-bearing decision is *which thresholds*, and those come from
observing the actual provider behavior (the comments at
`bloomreach-data-source.ts:131-137` and `connect.ts:86-100` are the
artifact).

**The deeper principle.** Constraint-aware design. The system isn't
fighting the rate limit; it's modelled around it. The 300s `maxDuration`,
the 60s cache TTL, the 1.1s spacing, the 10s retry default — all of
these are sized to a known constraint (Bloomreach allows ~1 req/s + a
~10s penalty window per violation). When the constraint changes, only
the thresholds change.

**Where it breaks.**

- **A stuck connection still costs 30s.** The transport timeout caps a
  single call at 30s. If three consecutive bootstrap calls hang, the
  route burns 90s before failing. The route's 300s ceiling absorbs
  this, but barely.
- **The retry ladder can stack on multiple calls.** If 3 of the 6
  monitoring tool calls each rate-limit twice (~10s each), that's
  60s of pure waiting in one route. The schema cache hides this on
  warm instances; cold starts pay full price.
- **The cache key is `name:JSON.stringify(args)`.** Two calls with the
  same args in different object orders are different keys. JSON
  stringification is deterministic in V8 for plain objects with
  string keys; once we start passing `Map` instances or symbols this
  breaks.
- **Cross-instance cache invalidation doesn't exist.** Each warm Vercel
  instance has its own cache; a redeploy or scale-out invalidates
  everything. Acceptable for an alpha; would need shared cache (Vercel
  KV) for higher concurrency.
- **Error caching is intentional NOOP.** If a 401 lands during a long
  scan, the next call attempts live again. That's right for auth (the
  user reconnects, the next call should try real), but wrong for, say,
  "tool not found" — which is permanent. We don't distinguish; both
  retry live.

**What to explore next.**

- `02-oauth-boundary.md` — what runs before the cache, gating access
- `03-datasource-seam.md` — where these defences live in the larger
  architecture
- `study-networking` — HTTP rate-limiting semantics, Retry-After, 429
- `study-distributed-systems` — token-bucket, leaky-bucket, fair
  scheduling under contention

## Interview defense

#### Q: "Walk me through how you handle the Bloomreach rate limit."

Three layered defences. **One**: a 60-second response cache keyed by
`name:JSON.stringify(args)`. **Two**: a 1.1-second inter-call spacer
that sleeps before issuing the next call if we're inside the previous
call's window. **Three**: a retry ladder that detects the rate-limit
shape in the response envelope, parses the server-stated penalty
window from the error text, waits it plus a 500ms cushion, and retries
up to three times.

A fourth defence sits one layer down in the transport: a 30-second
per-call timeout, so a single stuck call can't burn the route budget.

```
  cache (60s)   →   spacer (1.1s)   →   transport call
                                              │
                                       on isRateLimited:
                                              │
                                              ▼
                                       retry ladder (up to 3 × 10s)
```

**Surface:** "cache + spacer + retry + timeout, layered by cost."
**Probe:** if pressed — name `RETRY_BUFFER_MS = 500` and explain why
landing the retry at exactly the boundary risks re-hitting the window.

#### Q: "What's the load-bearing part? What breaks if you remove each defence?"

Each defence handles a different failure mode. Strip any one and you
fail in a different way:

```
  defence              what it prevents
  ───────              ────────────────
  cache (60s)          agents re-asking the same tool repeatedly in
                       one investigation → would 5-10x our call count
                       and trigger the rate limit faster
  spacer (1.1s)        concurrent code firing back-to-back → would
                       hit 429 on every call after the first
  retry ladder         transient 429s killing the whole scan → without
                       it, ONE rate-limit response would fail-fast and
                       drop the entire investigation
  timeout (30s)        a stuck connection eating the entire route
                       budget → without it, a hung MCP call could burn
                       300s
```

The KERNEL — the one part you can't lose and still call this a
production-grade rate-limited client — is the retry ladder with
parsed-window backoff. Drop the cache, agents get slower. Drop the
spacer, you hit 429 more often but the retry still recovers. Drop the
timeout, hung calls hurt. Drop the retry, ONE rate-limit response is
fatal to that whole route call. The retry is the load-bearing one.

Optional hardening (not load-bearing):

  → `RETRY_BUFFER_MS = 500` — quality-of-life, prevents boundary hits
  → don't-cache-errors — important but small; without it, errors pin
    for 60s instead of retrying live
  → distinct timeout error tag (`HTTP 0: timeout after 30000ms`) —
    debugging aid; the route still works without it

#### Q: "What changes at 10x users?"

Bloomreach's rate limit is per-user globally, so 10x concurrent users
doesn't change per-user budget. The defences scale per-user
automatically because the `BloomreachDataSource` is per-session (one
per request → one per user-active-tab). Cross-user contention isn't
real; per-user contention (one user, multiple tabs) is.

Where 10x DOES hurt:

  → memory: each warm Vercel instance holds N caches, one per session
    in flight. The cache is small (one Map per session) but it doesn't
    shrink — a user mid-investigation holds their cache until the
    request ends.
  → cold-start amplification: every cold instance re-bootstraps the
    schema and re-warms every per-tool cache. At 10x cold starts, that's
    10x the wasted live calls during cold-start spikes.

The move: a shared cache (Vercel KV) for the schema specifically — it's
big (~112KB), it's the same for every user with the same project, it
costs ~4 live calls to fetch. Tool-result cache stays per-instance;
those are smaller and more session-specific.

## See also

- `00-overview.md` — where this sits in the system
- `03-datasource-seam.md` — what's hidden inside the Bloomreach adapter
- `02-oauth-boundary.md` — what runs before this (auth)
- `study-networking` — 429, Retry-After, HTTP rate-limit semantics
- `study-distributed-systems` — token bucket, leaky bucket, fairness

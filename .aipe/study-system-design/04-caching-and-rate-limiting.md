# Caching + rate-limiting

**Industry name(s):** cache-aside (lazy caching) with TTL, client-side rate limiting / request throttling, retry-with-backoff
**Type:** Industry standard · Language-agnostic

> `McpClient.callTool` is the single choke-point for every MCP call: it serves cached results by key+TTL, spaces live calls to satisfy Bloomreach's 1 req/sec global limit, and retries bounded times on a rate-limit error — never caching failures.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Caching + rate-limiting lives entirely inside the Provider wrappers band — `McpClient.callTool` in `lib/mcp/client.ts` is a four-stage funnel (cache check → spacing gate → live call → retry) that every MCP request passes through. Above it sit the Agent loop and the per-agent classes, all calling through the same `McpCaller` interface. Below it sits the `SdkTransport` adapter that talks to Bloomreach's `~1 req/sec` server. This file is about how that one band turns a burst of agent tool calls into a paced, deduplicated stream that the upstream server will actually accept.

```
Zoom out — where caching + rate-limiting lives

┌─ Pipeline ─────────────────────────────────────┐
│  MonitoringAgent.scan → runAgentLoop           │
└─────────────────────┬──────────────────────────┘
                      │  mcp.callTool(name, args)
┌─ Provider wrappers ─▼──────────────────────────┐  ← we are here
│  McpClient.callTool (lib/mcp/client.ts)        │
│  ┌──────────────────────────────────────────┐  │
│  │ ★ cache check (TTL Map) ★                │  │
│  │     ↓ miss                                │  │
│  │ ★ spacing gate (1100 ms) ★               │  │
│  │     ↓                                      │  │
│  │ ★ live transport.callTool ★              │  │
│  │     ↓                                      │  │
│  │ ★ rate-limit retry (bounded) ★           │  │
│  │     ↓                                      │  │
│  │ cache write (success only)                │  │
│  └──────────────────────────────────────────┘  │
└─────────────────────┬──────────────────────────┘
                      │  HTTPS (~1 req/s limit)
┌─ External ─────────────────────────────────────┐
│  Bloomreach MCP server                         │
└────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how does one client class stay under a hard server limit (Bloomreach allows ~1 req/sec per user globally) while a briefing agent makes 6–13 sequential EQL calls in one run, without hand-rolling a retry at every call site? `McpClient` composes three policies in one method — a TTL cache that turns repeat reads into 0 ms hits, a fixed-interval spacing gate that delays each live call until at least 1100 ms have passed, and a bounded retry loop that re-enters the gate on a 429-equivalent response. The next sections walk each policy and the one rule that keeps them composing safely: never cache an error.

---

## Structure pass

**Layers.** Caching + rate-limiting is a single-class stack with four ordered stages: the **caller** (any agent in the pipeline), the **cache check** (TTL Map — short-circuits on hit), the **spacing gate** (1100 ms minimum interval between live calls), and the **live call + retry loop** (transport + bounded 429-handling). Each stage either returns or falls through to the next — a strict pipeline of policies composed inside `callTool`.

**Axis: failure.** Where does the bad thing originate, propagate, and get contained? This axis is right because the whole point of these four stages is *failure containment* — the cache contains stale-but-valid bursts, the spacing gate contains "we hit the server too fast" failures, the retry loop contains "the server already said no" failures, and the no-cache-on-error rule contains "don't memorize the failure" failures. Cost is the natural alternate axis (latency, retry budget) — but cost is the *consequence* of failure handling, not the structure. Pick failure and the seams pop; pick cost and the cache and spacing gate look like the same kind of optimization.

**Seams.** Three seams matter; one is load-bearing. **Seam 1: cache hit/miss boundary.** Failure cannot originate inside the cache (it's a Map lookup); it can only originate downstream of this seam. **Seam 2: spacing gate → live call.** Failure-origin flips from CLIENT-SIDE (we're guarding against overage) to SERVER-SIDE (the server might still 429 us, or the network might drop). **Seam 3 (load-bearing): live result → cache write decision.** This is the no-cache-on-error guard. Failure-containment flips from "this slot might get filled" to "this slot will be skipped." The retry loop and the cache compose safely *only* because this seam exists — without it a 429 would poison the cache for the whole TTL, blocking real retries until expiry.

```
Structure pass — caching + rate-limiting

┌─ 1. LAYERS ─────────────────────────────────────────┐
│  Caller · Cache (TTL Map) · Spacing gate (1100 ms) · │
│  Live call + retry loop                              │
└────────────────────────┬─────────────────────────────┘
                         │  pick the axis
┌─ 2. AXIS ─────────────▼──────────────────────────────┐
│  failure: where does a bad result originate,         │
│  propagate, and get contained?                       │
└────────────────────────┬─────────────────────────────┘
                         │  trace across layers, find flips
┌─ 3. SEAMS ────────────▼──────────────────────────────┐
│  S1: cache hit/miss (no failure possible upstream)   │
│  S2: spacing gate → live call (CLIENT → SERVER)      │
│  S3: live result → cache write ★load-bearing         │
│      (no-cache-on-error guard; the composition rule) │
└────────────────────────┬─────────────────────────────┘
                         ▼
                 Block 4 — How it works
```

```
S3 seam — "do we memorize this result?" answered two ways

┌─ Live call returned ┐  seam     ┌─ Cache write step ───┐
│  isError === true   │ ═════╪═══►│  SKIP write (no fill)│
│                     │  (it     │                       │
│  isError === false  │   flips) │  WRITE with expiresAt │
└─────────────────────┘          └───────────────────────┘
        ▲                                       ▲
        └────── same axis (failure), two answers ─┘
                → this is the cache↔retry composition rule
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

---

## How it works

Every tool call passes through the same four-stage funnel before a result reaches the caller.

```
┌─────────────────────────────────────────────────────┐
│                    callTool(name, args)               │
└───────────────────────┬─────────────────────────────┘
                        │
              ┌─────────▼──────────┐
              │  cache check (TTL)  │ ◀── cache hit → return immediately
              └─────────┬──────────┘
                        │ miss
              ┌─────────▼──────────┐
              │  spacing gate       │ ◀── wait until (lastCallAt + minIntervalMs)
              └─────────┬──────────┘
                        │
              ┌─────────▼──────────┐
              │  live network call  │
              └─────────┬──────────┘
                        │
              ┌─────────▼──────────┐
              │  rate-limit retry?  │ ◀── isRateLimited → sleep + retry (bounded)
              └─────────┬──────────┘
                        │
              ┌─────────▼──────────┐
              │  cache on success   │ ◀── isError → skip; success → set(key, expiresAt)
              └─────────┬──────────┘
                        │
                   result returned
```

Every call passes through this funnel. A cache hit exits at stage 1; an error result exits before stage 5 without writing the cache. **The load-bearing stage is the last one — no-cache-on-error.** The cache and the retry loop only compose safely because of that single rule; remove it and a 429 poisons the cache for the full TTL.

### Cache-aside with TTL

The cache is a `Map<key, { result, expiresAt }>` held on the provider wrapper instance. The key is `name + ":" + serialize(args)` — the tool name plus a deterministic serialization of every argument. The entry shape:

```
┌──────────────────────────────────────────────────────────┐
│  Map entry                                                │
│                                                           │
│  key:  "search_content:{"eql":"top 10 keywords","n":10}" │
│                                                           │
│  value: {                                                 │
│    result:    <the raw MCP response object>               │
│    expiresAt: 1716825600000   ← now + ttl (60 s default) │
│  }                                                        │
└──────────────────────────────────────────────────────────┘
```

On a cache check: if `cached.expiresAt > now`, return the stored result immediately with `fromCache: true` and `durationMs: 0`. The default TTL is 60 seconds; callers pass `cacheTtlMs` to override. `skipCache: true` bypasses the read but still writes a fresh entry on success — the debug "force refresh" path relies on this write-through behavior.

React Query parallel: this is `staleTime` on a query. Within the stale window, the cached data is returned synchronously without hitting the network.

### Inter-call spacing (the live-call path)

The live-call path is the only place the transport is called. Before calling the transport it computes `elapsed = now - lastCallAt` and waits `minIntervalMs - elapsed` milliseconds if the minimum interval has not yet passed.

```
time ──────────────────────────────────────────────────────────▶

  call A arrives                             call B arrives
       │                                          │
       ▼                                          ▼
  ┌────┤ liveCall A                          ┌────┤ liveCall B
  │    │ lastCallAt = 0                      │    │ elapsed = 300 ms
  │    │ elapsed = ∞  → no wait              │    │ 300 < 1100
  │    │ network call                        │    │ wait 800 ms ──────┐
  │    │ lastCallAt = T₀                     │    │                   │
  └────┘                                     │    │ network call ◀────┘
         │◀──── 1100 ms minimum ────────────▶│    │ lastCallAt = T₁
```

`lastCallAt` is a single instance field. Every live call — whether it was a cache miss or a retry — updates it after the transport returns. This means two back-to-back cache misses always have at least `minIntervalMs` between their network calls. The wrapper is constructed with this set to 1100 ms.

### Retry on rate-limit

After the first live call, the wrapper checks `isRateLimited(result)`. The predicate returns `true` when the result has `isError: true` and its JSON representation matches `/rate limit|too many requests/i`. The retry loop re-enters the live-call path (which itself enforces the spacing gap again) up to `maxRetries` times. Each wait honors a window parsed out of the error text when present, else exponential backoff off `retryDelayMs` (`retryDelayMs * 2 ** (retries - 1)`), with every wait capped at `retryCeilingMs`. Default values: `maxRetries = 3`, `retryDelayMs = 10_000` ms, `retryCeilingMs = 20_000` ms.

```
  liveCall → result
       │
  isRateLimited?
  ┌────┴────┐
  │ yes     │ no
  │         └──▶ continue to cache step
  ▼
  retries < maxRetries?
  ┌────┴─────┐
  │ yes      │ no
  │          └──▶ return error result (exhausted)
  ▼
  sleep(retryDelayMs)
  └──▶ liveCall → loop back to isRateLimited?
```

### No-cache-on-error

When `result.isError === true` the function returns immediately without writing to the cache. This covers all errors, not only rate-limit errors. Caching a 429 for 60 seconds would mean the next 60 seconds of calls return the error from cache without ever retrying the network — the briefing stays broken for a full minute with no way to recover short of a restart. Error results must always be live-retried by the next caller.

### The principle

Idempotent reads with stable inputs cache cleanly. Writes and error responses do not. This matches React Query's `staleTime` design: queries cache; mutations do not.

---

## Caching + rate-limiting — diagram

This diagram shows one call's complete path from entry to result. The Service layer (TypeScript) contains every decision. The Network/Provider boundary is the single line where bytes leave the process.

```
  ┌────────────────────────────────────────────────────────────────────┐
  │  SERVICE LAYER (McpClient)                                          │
  │                                                                     │
  │  callTool("search_content", { eql: "..." })                        │
  │       │                                                             │
  │  ┌────▼──────────────────────────────────────────────────────┐     │
  │  │  Cache check                                               │     │
  │  │  key = "search_content:{\"eql\":\"...\"}"                 │     │
  │  │  cached.expiresAt > Date.now() ?                          │     │
  │  │       │ yes                  │ no (miss / expired)        │     │
  │  │       ▼                      ▼                            │     │
  │  │  return { result,    proceed to liveCall                  │     │
  │  │    fromCache: true,                                       │     │
  │  │    durationMs: 0 }                                        │     │
  │  └───────────────────────────┬───────────────────────────────┘     │
  │                              │                                      │
  │  ┌───────────────────────────▼───────────────────────────────┐     │
  │  │  liveCall — spacing gate                                   │     │
  │  │  elapsed = Date.now() - lastCallAt                        │     │
  │  │  elapsed < 1100 ms? → await (1100 - elapsed) ms          │     │
  │  └───────────────────────────┬───────────────────────────────┘     │
  │                              │                                      │
  └──────────────────────────────┼──────────────────────────────────────┘
                                 │  NETWORK / PROVIDER BOUNDARY
  ┌──────────────────────────────▼──────────────────────────────────────┐
  │  Bloomreach MCP server                                               │
  │  transport.callTool(name, args) → raw result                        │
  └──────────────────────────────┬──────────────────────────────────────┘
                                 │
  ┌──────────────────────────────▼──────────────────────────────────────┐
  │  SERVICE LAYER (McpClient continued)                                 │
  │                                                                      │
  │  lastCallAt = Date.now()                                             │
  │                                                                      │
  │  ┌───────────────────────────────────────────────────────────┐      │
  │  │  Rate-limit retry loop                                     │      │
  │  │  isRateLimited(result) && retries < maxRetries?           │      │
  │  │       │ yes                  │ no                         │      │
  │  │       ▼                      ▼                            │      │
  │  │  retries++              proceed to cache step             │      │
  │  │  sleep(retryDelayMs)                                      │      │
  │  │  liveCall again ─────────────────────────────────────────▶│      │
  │  └───────────────────────────────────────────────────────────┘      │
  │                                                                      │
  │  ┌───────────────────────────────────────────────────────────┐      │
  │  │  Cache write (success only)                                │      │
  │  │  result.isError === true? → return, do NOT write cache    │      │
  │  │  else → cache.set(key, { result, expiresAt: now + ttl })  │      │
  │  └───────────────────────────────────────────────────────────┘      │
  │                                                                      │
  │  return { result, durationMs, fromCache: false }                    │
  └──────────────────────────────────────────────────────────────────────┘
```

The spacing gate and the retry loop both live inside the Service layer, so Bloomreach never sees bursts regardless of how many callers queue up above `McpClient`.

---

## Implementation in codebase

### Files, functions, and line ranges

| Symbol | File | Lines |
|---|---|---|
| `isRateLimited` | `lib/mcp/client.ts` | L18–L22 |
| `parseRetryAfterMs` | `lib/mcp/client.ts` | L31–L38 |
| `sleep` | `lib/mcp/client.ts` | L40–L42 |
| `ClientOpts` interface | `lib/mcp/client.ts` | L5–L12 |
| `McpClient` cache field | `lib/mcp/client.ts` | L80 |
| `McpClient` constructor | `lib/mcp/client.ts` | L87–L95 |
| `callTool` — cache check | `lib/mcp/client.ts` | L105–L110 |
| `callTool` — retry loop | `lib/mcp/client.ts` | L121–L132 |
| `callTool` — no-cache-on-error | `lib/mcp/client.ts` | L137–L139 |
| `callTool` — cache write | `lib/mcp/client.ts` | L143–L144 |
| `liveCall` | `lib/mcp/client.ts` | L148–L163 |
| `listTools` | `lib/mcp/client.ts` | L169–L171 |
| `connectMcp` — 1100 ms construction | `lib/mcp/connect.ts` | L91–L96 |

### Test coverage (`test/mcp/client.test.ts`)

| Test | Lines | What it exercises |
|---|---|---|
| cache miss, `fromCache: false` | L15–L23 | basic transport delegation |
| cache hit within TTL | L24–L32 | `fromCache: true`, 1 transport call |
| per-`name+args` keying | L33–L40 | different args → different entries |
| `skipCache` bypass | L41–L48 | read skip, write-through confirmed |
| TTL expiry | L49–L59 | `vi.advanceTimersByTime(1001)` |
| `minIntervalMs` spacing | L60–L79 | 199 ms → still waiting; 200 ms → done |
| `listTools` delegation | L80–L88 | transport passthrough |
| no-cache-on-error | L89–L100 | error result not served from cache |
| retry then succeed | L101–L110 | rate-limit response, then succeeds |
| parsed retry-after window | L111–L141 | waits the "(1 per 10 second)" window, then caches |
| explicit "Retry after ~N seconds" hint | L142–L168 | parsed hint preferred over backoff base |
| exhaust `maxRetries` | L169–L177 | returns final error after `maxRetries+1` calls |
| wraps transport throw as `McpToolError` | L178–L189 | tagged with tool name + detail |
| includes thrown `error.cause` in detail | L190–L197 | nested cause surfaced |

### Pseudocode of `callTool` flow

```
callTool(name, args, options):
  key = name + ":" + JSON.stringify(args)
  ttl = options.cacheTtlMs ?? 60_000

  if not options.skipCache:
    entry = cache.get(key)
    if entry and entry.expiresAt > Date.now():
      return { result: entry.result, fromCache: true, durationMs: 0 }

  start = Date.now()
  result = await liveCall(name, args)       // enforces minIntervalMs

  retries = 0
  while isRateLimited(result) and retries < maxRetries:
    retries++
    await sleep(retryDelayMs)
    result = await liveCall(name, args)

  durationMs = Date.now() - start

  if result.isError:
    return { result, durationMs, fromCache: false }   // do NOT write cache

  cache.set(key, { result, expiresAt: Date.now() + ttl })
  return { result, durationMs, fromCache: false }
```

### GitHub links

- `lib/mcp/client.ts` full file: https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/client.ts
- `callTool` (L97–L146): https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/client.ts#L97-L146
- `liveCall` (L148–L163): https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/client.ts#L148-L163
- `isRateLimited` (L18–L22): https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/client.ts#L18-L22
- `connect.ts` 1100 ms construction (L91–L96): https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/connect.ts#L91-L96
- `test/mcp/client.test.ts` full file: https://github.com/rlynjb/blooming_insights/blob/main/test/mcp/client.test.ts

---

## Elaborate

### Where it comes from

**Cache-aside** (also called lazy caching) is a standard read pattern: the application manages the cache itself rather than delegating to a caching proxy. On a miss, the application fetches from the source, populates the cache, and returns. This is the model used by every major frontend data-fetching library (React Query, SWR, Apollo Client).

**Client-side rate limiting / request throttling** enforces a minimum interval between outbound calls at the caller side, before a server-side 429 ever fires. This is different from a token-bucket limiter (which allows short bursts) or a leaky-bucket limiter (which smooths a burst over time). A fixed minimum interval is a strict throttle: at most one call per `minIntervalMs`.

**Retry-with-backoff** is the standard error-recovery pattern for transient failures. Bounded retries prevent infinite loops; a delay between retries gives the remote server time to recover. The variant here prefers a wait window parsed out of the Bloomreach error text (`parseRetryAfterMs`, `client.ts` L31–L38) and otherwise uses exponential backoff off `retryDelayMs` capped at `retryCeilingMs`; the rationale is documented in the comment block at `client.ts` L115–L120.

### The deeper principle

```
              reads                        writes / errors
   ┌──────────────────────────┐   ┌──────────────────────────┐
   │  idempotent              │   │  not idempotent          │
   │  stable inputs → cache   │   │  side-effectful          │
   │  React Query staleTime   │   │  error → live retry      │
   │  Map memoization         │   │  mutation → skip cache   │
   └──────────────────────────┘   └──────────────────────────┘
```

Every call through `McpClient` is a read of Bloomreach analytics data. The same EQL query with the same arguments returns the same result within a short time window. Caching reads is safe. Errors and mutations (if any) must not be cached because subsequent callers need a real response, not a stale failure.

### Where it breaks down

1. **In-memory cache does not survive serverless cold starts.** The cache `Map` lives on the `McpClient` instance. In a Vercel serverless function, a new instance is created on every cold start. Every cold-start request is a cache miss regardless of how recent the prior response was.

2. **Per-process spacing does not coordinate across instances.** `lastCallAt` is an instance field. If two serverless function instances run concurrently — both serving different users or different requests — each instance has its own `lastCallAt`. Both can call Bloomreach simultaneously, sending 2 req/sec even though each instance thinks it is compliant with 1 req/sec. Bloomreach counts requests per user globally; the per-process spacing breaks under horizontal scaling.

3. **Backoff has no jitter.** Retries use exponential backoff off `retryDelayMs` (or a parsed retry-after window) capped at `retryCeilingMs`, but no random jitter is added. Multiple callers that all receive a 429 at the same instant compute the same wait and wake together — a synchronized burst. Full jitter (`random(0, delay)`) is the industry standard for avoiding the thundering herd.

### What to explore next

- Distributed rate limiting with a shared Redis counter (sliding window or token bucket) — the production fix for multi-instance spacing
- Stale-while-revalidate: returning cached data immediately while refreshing in the background — extends the benefit of caching without serving stale data for longer
- `p-queue` or `p-limit`: a priority-aware concurrency queue that can enforce ordering and concurrency limits at the application level, replacing the fixed `minIntervalMs` approach

---

## Interview defense

### What they are really asking

"Walk me through your rate limiting" is asking whether you understand the difference between client-side throttling and server-side enforcement, whether you know that in-memory state is process-local, and whether you have thought about what happens when the process is not alone.

### Q + A

**[mid] How does `McpClient` prevent hitting Bloomreach's 1 req/sec limit?**

`liveCall` reads `Date.now() - this.lastCallAt` before every network call. If less than `minIntervalMs` (1100 ms) has passed, it awaits the difference. `lastCallAt` is updated after every call returns. The spacing is enforced even on retries because retries go through `liveCall` again.

```
  call 1 ──▶ liveCall ──▶ network (T=0)       lastCallAt = T₀
  call 2 ──▶ liveCall ──▶ wait until T₀+1100  lastCallAt = T₁
  call 3 ──▶ liveCall ──▶ wait until T₁+1100  lastCallAt = T₂
```

**[senior] When does `callTool` NOT write to the cache, and why?**

When `result.isError === true` (`lib/mcp/client.ts` L137–L139). Any error result — rate limit, bad query, server error — is returned directly without a cache write. Caching an error would cause the next 60 seconds of callers to receive the cached failure without ever retrying the network. The briefing would stay broken for a full minute.

```
  result arrives
       │
  result.isError?
  ┌────┴────┐
  │ true    │ false
  │         └──▶ cache.set(key, { result, expiresAt })
  ▼
  return error immediately (no cache write)
```

**[arch] Does the 1100 ms spacing guarantee the rate limit is respected across a fleet of serverless instances?**

No. `lastCallAt` is an instance field on `McpClient`, which is created per request in `connectMcp`. Each serverless invocation has its own instance and its own `lastCallAt`. Two concurrent invocations for the same user can both observe `lastCallAt = 0` and both call Bloomreach simultaneously, sending 2 req/sec against a 1 req/sec quota.

```
  Instance A:  lastCallAt=0 ──▶ liveCall at T=0
  Instance B:  lastCallAt=0 ──▶ liveCall at T=0   ← both fire; 2 req/sec
                                                     Bloomreach sees a burst
```

The fix: a shared distributed limiter (Upstash sliding window, Redis `SET NX PX`) that all instances read and write atomically. `lib/mcp/connect.ts` L12–L14 documents this as a known issue: in-memory persistence "works ONLY within a single Node process."

### The dodge

**"Why a fixed 1.1 s delay instead of a real token bucket?"**

Honest answer: it is the simplest thing that works for one process. A token bucket allows a burst of accumulated credit; a fixed interval never does. For a single serverless function handling one user at a time, a token bucket and a fixed delay are functionally identical — the user never accumulates credit because calls arrive spread across a briefing run, not in bursts.

The trade-off is that a token bucket (`Bottleneck`, `p-throttle`) handles bursty patterns better without violating the rate limit, at the cost of a dependency and more configuration. The comment block in `connect.ts` L81–L88 explicitly explains why proactive spacing stays at ~1.1 s instead of the full observed 10 s window.

```
  Fixed delay (current):
  ─────┬──────────────┬──────────────┬──────────────▶  time
       call           call           call
       │◀── 1100 ms ──▶│◀── 1100 ms ──▶│

  Token bucket (alternative):
  ─────┬──┬──────────┬──┬──────────▶  time
       call call      call call
       (burst allowed if bucket has credit)
       (total rate still ≤ 1/sec average)
```

Both respect the average rate limit. The token bucket is better under load variation; the fixed delay is simpler to reason about.

### Anchors

- `lib/mcp/client.ts` L148–L163 — `liveCall`, the spacing gate
- `lib/mcp/client.ts` L121–L132 — retry loop
- `lib/mcp/client.ts` L137–L139 — no-cache-on-error guard
- `lib/mcp/connect.ts` L91–L96 — `minIntervalMs: 1100` (and `retryDelayMs`/`retryCeilingMs`) with rate-limit comment
- `test/mcp/client.test.ts` L60–L79, L89–L100, L101–L110 — spacing, no-cache-error, retry tests

---

## Validate your understanding

### Level 1 — reconstruct

Without looking at the code, write out the four stages every `callTool` call passes through. Name the data structures involved (what is the cache type? what is the cache key format?). Name the fields that track spacing and retry state.

### Level 2 — explain

Open `lib/mcp/client.ts`. Explain what `skipCache: true` does on both the read path (L105–L110) and the write path (L143–L144). Why does a `skipCache` call still write to the cache? Which use-case does this serve?

### Level 3 — apply

Scenario: two briefings run in the same process at the same time. User A's briefing calls `callTool("search_content", { eql: "top keywords" })`. One millisecond later, User B's briefing calls `callTool("search_content", { eql: "top keywords" })`.

- Does User B get a cache hit? Why or why not? (Cite `lib/mcp/client.ts` L80 — is the cache shared or per-instance?)
- Does the 1100 ms spacing still protect Bloomreach? If User A and User B share the same `McpClient` instance, yes. If they have separate instances (one per `connectMcp` call), cite `lib/mcp/connect.ts` L91–L96 to show each call to `connectMcp` creates a new `McpClient`. What does that mean for the spacing guarantee?
- Now extend the scenario: two serverless function instances each handle one of these briefings. Does the 1100 ms spacing protect Bloomreach? Cite `lib/mcp/client.ts` L81 (`private lastCallAt = 0`) and explain why.

### Level 4 — defend

A colleague argues: "We should remove the in-memory cache because it makes debugging harder — you never know if you're seeing fresh data." What is the concrete cost of removing the cache for a 10-call briefing run against Bloomreach's 1 req/sec limit? Calculate the minimum wall-clock time with and without the cache. Then explain the no-cache-on-error rule and why it addresses the "stale bad data" concern.

### Quick check

- What does `isRateLimited` test for? (Name the two conditions — `lib/mcp/client.ts` L19–L21.)
- What is the default TTL? (Cite the line.)
- How many total transport calls does `maxRetries: 2` allow? (Initial call + 2 retries = 3.)
- Does `listTools` use the cache? (Cite `lib/mcp/client.ts` L169–L171 and explain why not.)

## See also

→ [audit.md](./audit.md) (caching-and-invalidation + failure-handling-and-reliability lenses — the load-bearing MCP choke-point) · [01-request-flow.md](./01-request-flow.md) · [03-provider-abstraction.md](./03-provider-abstraction.md) · `.aipe/study-system-design-dsa/02-dsa/01-ttl-cache.md` (DSA mechanism depth) · `.aipe/study-system-design-dsa/02-dsa/02-rate-limit-and-retry.md`

---
Updated: 2026-06-02 — promoted from legacy archive `.aipe/study-system-design-dsa/01-system-design/` into v1.59.2 audit-style layout; See also cross-links re-pointed to sibling pattern files + audit.md lens (legacy DSA archive refs retained — that folder is preserved).
Updated: 2026-05-28 — refreshed code references to current line numbers; retry now uses a parsed retry-after window / exponential backoff (default `retryDelayMs = 10_000`, `retryCeilingMs = 20_000`)
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-05-31 — Applied study.md v1.52 voice trait (verdict first, then rank what matters) — clarity edits to Move 2.

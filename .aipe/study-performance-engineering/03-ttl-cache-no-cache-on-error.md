# 03 — TTL cache with no-cache-on-error

60s response cache · Industry standard (TTL cache) · Project-specific failure-mode hardening

## Zoom out — where this pattern lives

Sitting at the same seam as spacing: between the agent and the network. Every tool call goes through the cache check first. The interesting story is not that there's a cache — it's that the cache will not write an error result. That single early return is what stops a transient 429 from poisoning the cache for 60s.

```
  Zoom out — the cache sits at the adapter seam

  ┌─ Agent layer ──────────────────────────────────────────────┐
  │  AptKit agent loop → callTool(name, args)                   │
  └────────────────────────────┬───────────────────────────────┘
                               │
  ┌─ DataSource adapter ───────▼───────────────────────────────┐
  │  BloomreachDataSource.callTool                              │
  │   ┌──────────────────────────────────────────────────┐     │
  │   │  ★ THIS CONCEPT — the 60s TTL cache ★             │     │
  │   │  + the no-cache-on-error early return             │     │
  │   └──────────────────────────────────────────────────┘     │
  └────────────────────────────┬───────────────────────────────┘
                               │
  ┌─ MCP transport ────────────▼───────────────────────────────┐
  │  StreamableHTTPClientTransport → Bloomreach                 │
  └────────────────────────────────────────────────────────────┘
```

The pattern is two moves stacked: a stock TTL cache (everyone has seen one), plus a 6-line early return that is the actual hardening. The early return is what makes this implementation correct under transient upstream failure.

## Structure pass — layers, axis, seams

**Layers — in cache terms:**
- Caller — the agent issuing `callTool(name, args)`
- Cache layer — the `Map<key, { result, expiresAt }>` in `BloomreachDataSource`
- Live layer — `liveCall` (which does spacing + transport)

**The axis: what counts as a "successful" result?** This is the load-bearing question for any error-aware cache. Trace it across the seams:

```
  Tracing "what counts as success?" across the layers

  ┌─ Caller (agent) ────────────────────────────────┐
  │  success = "I got a result I can hand to Claude" │   the agent sees:
  │  even an error envelope IS a result              │   any return = success
  └─────────────────────────────────────────────────┘
       ┌─────────────────────────────────────────────┐
       │ Cache layer                                  │
       │  success = "result.isError === false"        │  ← AXIS FLIPS HERE
       │  an isError result is REFUSED for caching    │   strict definition
       └─────────────────────────────────────────────┘
            ┌────────────────────────────────────────┐
            │ Live layer                              │  success = "the HTTP
            │  success = "the transport returned"     │  request completed",
            │  the result content is opaque           │   error or not
            └────────────────────────────────────────┘
```

The axis flips at the cache-vs-live seam. To the live layer, an error envelope coming back from the server is a successful HTTP request. To the cache layer, that exact same envelope is a failure that must not be persisted. The 6-line early return at `bloomreach-data-source.ts:179` IS this axis flip — it's literally the code that says "the layer below me would have cached this; I refuse."

## How it works

### Move 1 — the mental model

You know how `useEffect`'s dependency array works: React caches the effect's result keyed by the deps; if the deps haven't changed, skip the effect. A TTL cache is the same shape with time as the dependency:

```
  TTL cache — the kernel

           callTool(name, args)
                │
                ▼
           key = `${name}:${JSON.stringify(args)}`
                │
                ▼
           cache.get(key) AND cached.expiresAt > now?
                │ yes → return { result, fromCache: true }
                │ no  →
                ▼
           result = liveCall(name, args)
                │
                ▼
           cache.set(key, { result, expiresAt: now + ttl })
                │
                ▼
           return { result, fromCache: false }
```

That kernel works for the happy path. The interesting failure mode is what happens when `liveCall` returns an error result (a 429 envelope, an auth-failure envelope, a transient server error). The naive cache would just write it — and now for the next 60s every caller gets the same error from cache, with no chance to recover. The hardening is one branch:

```
  No-cache-on-error — the early return

           result = liveCall(name, args)
                │
                ▼
           result.isError === true?
                │ yes → return { result, fromCache: false }
                │       ← never touches the cache
                │ no  →
                ▼
           cache.set(key, { result, ... })
```

### Move 2 — step by step

**The cache state — `Map<key, { result, expiresAt }>`**

A `Map` keyed by `name:JSON(args)`. Each entry carries an absolute `expiresAt` timestamp so expiry is a simple `>` check, no background sweep needed.

```ts
// lib/data-source/bloomreach-data-source.ts:121-130
export class BloomreachDataSource implements DataSource {
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
  private lastCallAt = 0;
  private minIntervalMs: number;
  private maxRetries: number;
  private retryDelayMs: number;
  private retryCeilingMs: number;
  // ...
}
```

The cache lives on the instance. The Bloomreach instance lives across requests (the OAuth session lives in the cookie, but the adapter object is module-scoped per Vercel function instance). Within one warm function instance, the cache is shared across requests; across cold starts, it resets. That isolation is implicit — we don't manage it, Vercel's serverless lifecycle does.

**The key — `name:JSON(args)`**

```ts
// lib/data-source/bloomreach-data-source.ts:144
const cacheKey = `${name}:${JSON.stringify(args)}`;
```

Two same-named calls with different args get different keys. The pseudocode:

```
  cacheKey = toolName + ":" + canonical_json(args)
  // canonical_json: JSON.stringify is order-preserving in V8, so
  // {project_id: "x", eql: "..."} keys differently from {eql: "...", project_id: "x"}
  // — known footnote, not a bug in practice because the agent's tool_use
  //   blocks come from the model and have consistent property order per turn.
```

**The lookup — TTL check inline**

```ts
// lib/data-source/bloomreach-data-source.ts:147-152
if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

Three observations:
1. `durationMs: 0` on the cache hit — the metric reflects the actual work done, not the wall-clock to read the map. This is honest. A consumer reading the trace sees a cache hit as instant.
2. `fromCache: true` is part of the public return shape (the `CallToolResult<T>` type at line 36). Callers can see whether a result was served from cache and decide what to do (the demo capture path uses this to skip recording cache hits).
3. `skipCache` is an opt-in bypass used by `/api/mcp/capture` and `/api/mcp/call` (the dev tooling routes). The agents never set it.

**The live call**

If the cache misses (or `skipCache: true`), call `liveCall` (which handles spacing + transport). On the way back, the result may or may not be an error envelope.

```ts
// lib/data-source/bloomreach-data-source.ts:154-155
const start = Date.now();
let result = await this.liveCall(name, args, options.signal);
// ... (retry ladder runs here — see 02-mcp-spacing-and-retry.md)
```

**The retry ladder**

(Covered in `02-mcp-spacing-and-retry.md`.) When `result` is rate-limited, we retry up to 3 times honoring the server's stated window. At the end of this block, `result` is either the eventual successful response OR the final 429 envelope after exhausting retries.

**The no-cache-on-error early return — THE HARDENING**

This is the move. Six lines that prevent the cache from getting poisoned.

```ts
// lib/data-source/bloomreach-data-source.ts:176-182
const durationMs = Date.now() - start;

// Don't cache error results — they should not poison the cache.
if ((result as any)?.isError === true) {
  return { result: result as T, durationMs, fromCache: false };
}
```

Read it out loud: if the result has `isError: true`, return BEFORE the `cache.set` line below. The error result still goes back to the caller (the agent needs to see it to decide what to do), but it never enters the cache. The next caller hits the live server and gets a real answer.

Execution trace — a 429 storm:

```
  t = 0s     callTool("execute_analytics_eql", {...})
             → cache miss
             → liveCall → 429 → retry ladder exhausted → returns { isError: true }
             → EARLY RETURN at line 179 → cache untouched
             → caller sees the error

  t = 0.5s   callTool("execute_analytics_eql", {...})  ← SAME ARGS
             → cache miss (the previous call refused to cache the error)
             → liveCall → success this time → returns real result
             → cache.set(key, { result, expiresAt: t+60s })
             → caller sees the success

  (vs the buggy alternative — cache the error envelope at t=0:
  t = 0.5s   callTool("execute_analytics_eql", {...})
             → cache HIT — returns the 429 envelope from cache
             → caller has no chance to recover until t=60s when cache expires
             → 59 seconds of guaranteed failure for no reason)
```

That is the bug this single-line check prevents.

**The success path — `cache.set`**

Only reached when the result is NOT an error.

```ts
// lib/data-source/bloomreach-data-source.ts:184-187
// Note: a skipCache call still refreshes the cache (write-through), which is
// the desired behavior for the /debug "force fresh" path.
const now = Date.now();
this.cache.set(cacheKey, { result, expiresAt: now + ttl });
return { result: result as T, durationMs, fromCache: false };
```

`ttl` defaults to 60_000 (`options.cacheTtlMs ?? 60_000` at line 145). The comment on the `skipCache` interaction is the second smart move: `skipCache: true` bypasses the READ but still does the WRITE, so the dev tooling's "force fresh" path also warms the cache for subsequent calls. Write-through caching as a design decision, not an accident.

### Move 3 — the principle

The skeleton of every error-aware cache is the same: lookup, TTL check, live call, **decide whether the result is cacheable**, write. The decision step is where every implementation lives or dies. The "cache everything" version is broken under upstream transient failure; the "cache only on explicit success" version recovers automatically the next call.

The principle: **a TTL cache is two mechanisms, not one — the cache itself, AND the cacheability predicate.** The cache is the obvious half; the predicate is the load-bearing half. Strip the predicate and a transient 429 sticks for 60s. The predicate is one branch and most implementations don't have it.

## Primary diagram

The full pattern in one frame.

```
  TTL cache with no-cache-on-error — the complete flow

  ┌─ BloomreachDataSource.callTool ──────────────────────────────────────┐
  │                                                                        │
  │  cacheKey = `${name}:${JSON.stringify(args)}`                         │
  │  ttl      = options.cacheTtlMs ?? 60_000                              │
  │                                                                        │
  │  ┌─ 1. cache check ────────────────────────────────────────────┐     │
  │  │  if (!options.skipCache) {                                   │     │
  │  │    cached = cache.get(cacheKey)                              │     │
  │  │    if (cached && cached.expiresAt > Date.now()) {            │     │
  │  │      return { result, durationMs: 0, fromCache: true }       │     │
  │  │    }                                                          │     │
  │  │  }                                                            │     │
  │  └──────────────────────────────────────────────────────────────┘     │
  │                                                                        │
  │  ┌─ 2. live call (with spacing + retry) ───────────────────────┐     │
  │  │  start = Date.now()                                          │     │
  │  │  result = await liveCall(name, args, signal)                 │     │
  │  │  retry ladder on isRateLimited(result)                       │     │
  │  └──────────────────────────────────────────────────────────────┘     │
  │                                                                        │
  │  ┌─ 3. cacheability check ──── THE HARDENING ──────────────────┐     │
  │  │  if (result.isError === true) {                              │     │
  │  │    return { result, durationMs, fromCache: false }           │     │
  │  │            ← early return, cache untouched                   │     │
  │  │  }                                                            │     │
  │  └──────────────────────────────────────────────────────────────┘     │
  │                                                                        │
  │  ┌─ 4. write + return ─────────────────────────────────────────┐     │
  │  │  cache.set(cacheKey, { result, expiresAt: now + ttl })       │     │
  │  │  return { result, durationMs, fromCache: false }             │     │
  │  └──────────────────────────────────────────────────────────────┘     │
  └──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

**The second cache in the same file.** There's a second cache hiding inside the same module: the schema cache in `lib/mcp/schema.ts:131,190` — a module-level `let cached: WorkspaceSchema | null = null` plus an early return if `cached` is set. That cache has NO TTL and NO error gate, because schema bootstrap is all-or-nothing (the function throws if any of the 4 calls fail, so an error never reaches the `cached =` assignment). Different cache, different problem, different shape — a useful contrast that confirms the response-cache's error-gate is doing real work.

**The third cache.** `lib/state/investigations.ts` caches whole captured investigation streams (NDJSON event arrays) keyed by `insightId`. That cache has NO TTL — it's a session-lifetime store for replayed captures. Three caches in the codebase, three different invalidation strategies, each matched to what the cache holds:

```
  Cache           TTL?   Error-gate?   Why the choice
  ───────────     ────   ───────────   ─────────────────────────────────
  Response cache  60s    YES           transient upstream errors are real;
  (this file)                          short TTL because data changes
                                       slowly but might
  Schema cache    none   N/A           bootstrap throws on error;
  (schema.ts)                          schema is stable for the function's
                                       warm lifetime
  Investigation   none   N/A           captured snapshots are golden;
  cache                                they're written once after a
                                       successful run, never updated
```

**The "skip-cache writes through" footnote.** The `skipCache` bypass refreshes the cache on write. This is unusual — most "skip cache" flags also skip the write. The reason here: `skipCache: true` is only used by the dev tooling (`/api/mcp/call`, `/api/mcp/capture`) when an operator deliberately wants fresh data. Refreshing the cache means the next normal caller benefits too. The behavior is documented inline (line 185).

**Where this pattern comes from.** The "TTL cache + cacheability predicate" shape is the standard HTTP cache layer (think Squid, Varnish) reduced to its kernel. HTTP defines the predicate via response headers (`Cache-Control: no-store` on errors, status-code-based caching rules). This implementation is a smaller, in-process version of the same idea: the predicate is `!result.isError` and the TTL is constant.

**Adjacent guides.**
- `02-mcp-spacing-and-retry.md` — the retry ladder runs BEFORE the cacheability check, so retries on transient 429s become real results before the cache decides whether to write.
- `01-vercel-route-budget.md` — within a warm Vercel instance, the cache makes a re-run of the same investigation effectively free, bringing the 300s budget back down toward Anthropic-only time.
- `study-database-systems` covers cache-invalidation strategy more broadly.

## Interview defense

> **"What's the load-bearing part of this cache most implementations get wrong?"**

```
  The cacheability predicate — six lines that change the shape

  buggy: cache.set(key, { result, expiresAt })  ← always writes
   │
   │  result is { isError: true } (a 429 envelope)?
   │     → still cached
   │     → 60 seconds of guaranteed failure
   │
  ours:  if (result.isError === true)
            return { ..., fromCache: false }   ← early return BEFORE the set
         cache.set(key, { result, expiresAt })  ← only success path writes
```

The cacheability predicate. The cache is two mechanisms — the cache itself, and the rule about what's allowed in. Most implementations have the cache and skip the rule. We have a 6-line early return at `lib/data-source/bloomreach-data-source.ts:179` that says "if `result.isError === true`, return before writing." Without that, a transient 429 from the upstream gets cached for 60 seconds and EVERY subsequent caller hits the same error. With it, the next call retries the live server and gets a real answer. The bug-prevention is the lesson; the cache itself is incidental.

> **"How does this interact with the spacing + retry mechanism in the same file?"**

The order matters. The retry ladder runs BETWEEN the live call and the cacheability check. So: cache miss → live call → up to 3 retries on rate-limit → cacheability check → cache write OR early return. By the time the cacheability check fires, transient rate-limit errors have already been retried. What remains as `isError: true` at that point is a persistent failure (auth, server error, etc.), which is exactly what should NOT be cached. The mechanisms are stacked deliberately. Anchor: `lib/data-source/bloomreach-data-source.ts:155-187` reads top-to-bottom as one flow.

> **"Why a 60-second TTL?"**

The data refresh rate at the upstream is on the order of minutes for the metrics the agent queries (ecommerce event aggregates over 90-day windows). 60 seconds is short enough that staleness is invisible to the user (a re-run of the same investigation within a minute returns the same numbers anyway), and long enough that an agent making the same `execute_analytics_eql` call twice in one investigation pays the network cost once. It's not tuned with measurement — it's a "short enough to be safe, long enough to be useful" heuristic. The 90-day window math is what makes the choice safe.

## See also

- `02-mcp-spacing-and-retry.md` — the retry ladder that runs before the cacheability check
- `01-vercel-route-budget.md` — within a warm instance, cache hits return the budget toward Anthropic-only time
- `audit.md` → `caching-batching-and-backpressure` lens

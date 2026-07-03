# 04 · Response cache — 60s TTL, keyed by (name, args)

**Memoization with TTL · Language-agnostic.** Also called *result
cache* or *tool-call cache*. Sometimes: *poor man's cache* when
scoped per-process; *distributed cache* when shared.

## Zoom out — where the cache sits

Between the agent and the transport. Every tool call goes through
`BloomreachDataSource.callTool`. On a cache hit, the transport
never runs — you save a network round-trip AND you don't consume
Bloomreach's ~1 req/s budget.

```
  Zoom out — the response cache seam

  ┌─ Agent (ReAct loop) ─────────────────────────────────────┐
  │  dataSource.callTool('get_event_segmentation', args)      │
  └───────────────────────────────┬───────────────────────────┘
                                  │
  ┌─ BloomreachDataSource ────────▼───────────────────────────┐
  │                                                            │
  │   ★ cache = Map<`name:args`, {result, expiresAt}> ★        │
  │                                                            │
  │   cacheKey = `${name}:${JSON.stringify(args)}`             │
  │   if hit && !expired: return { fromCache: true }           │
  │       │                                                    │
  │       ▼ miss                                               │
  │   spacing gate → liveCall → transport                      │
  │   on success: cache.set(cacheKey, { result, expiresAt })   │
  └────────────────────────────────┬──────────────────────────┘
                                   │
  ┌─ MCP transport ────────────────▼──────────────────────────┐
  │  HTTPS · Bloomreach loomi · rate-limited                   │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in — what one cache hit saves.** A hit skips: the 1.1s
spacing gate, the ~200–500ms network round trip, one credit off
Bloomreach's rate-limit budget, and potentially a 429 retry
window if the budget is already tight. Cost is O(1) map lookup.

## Structure pass — layers, axis, seams

**Layers.** Agent → data-source (this cache) → transport → server.
The cache lives at the data-source layer specifically because
that's the seam where the tool-call abstraction is complete: `name`
+ `args` fully specify the call. Placing the cache above (agent
level) would need to serialize an entire message history; placing
it below (transport level) would need to inspect JSON-RPC frames.

**Axis: what's the identity of a cache entry?**

```
  Axis — "what makes two calls equivalent?"

    (name = 'get_event_segmentation',
     args = {event: 'checkout', breakdown: [...], date_range: [...]})
                       │
                       ▼
     JSON.stringify(args)  ← full arg equality
                       │
                       ▼
     `${name}:${json}`      ← composite key
                       │
                       ▼
     Map key match          ← O(1) lookup
```

**Seams.** Two: the `cacheKey` composition
(`bloomreach-data-source.ts:144`) is one seam — if you change how
args are canonicalized, cache hit rate changes. The
`isError`-check-before-write (`:179-181`) is the other — errors
are NOT cached, so a transient failure doesn't poison the next
60s.

## How it works

### Move 1 — the mental model

You already know `useMemo(() => expensiveWork(a, b), [a, b])` in
React: same inputs, cached result, skip the work. This is that
primitive at the tool-call boundary — same `(name, args)`, cached
result, skip the network call.

```
  Pattern — TTL-bounded memoization

    key = f(name, args)
    ┌──────────────┐
    │ cache.get(k) │
    └──────┬───────┘
           │
        hit + fresh?
         yes│      │no
            ▼      ▼
     return    liveCall
     early     └─ok─►  cache.set(k, {result, now + 60s})
                       return
              └─err─►  return (no cache write)
```

**Skeleton part everyone forgets.** *Errors are not cached.*
Without that guard, one transient 429 would fill the cache with
"rate limited" and the next 60 seconds of duplicate calls would
short-circuit to the same failure. See `bloomreach-data-source.ts:178-181`:

```ts
// Don't cache error results — they should not poison the cache.
if ((result as any)?.isError === true) {
  return { result: result as T, durationMs, fromCache: false };
}
```

Drop that check and every retry ladder failure becomes a
60-second cache lockout.

### Move 2 — walking the mechanism

#### The cache and its key

`lib/data-source/bloomreach-data-source.ts:122`:

```ts
export class BloomreachDataSource implements DataSource {
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
```

**Instance-scoped, in-process.** One `Map` per adapter instance.
In the current setup, one adapter per request (`makeDataSource`
constructs it per session), so the cache is really per-request-
plus-Vercel-instance-warmth. If two requests hit the same warm
instance and use the same args, the second gets a hit; if they
land on different instances, both miss. The comment at
`bloomreach-data-source.ts:122` doesn't dwell on this; the route
comment at `app/api/agent/route.ts:34-35` names the parent
constraint ("Vercel's per-instance memory").

`bloomreach-data-source.ts:144`:

```ts
const cacheKey = `${name}:${JSON.stringify(args)}`;
```

**Why `JSON.stringify(args)` and not a stable serialize.**
JavaScript's `JSON.stringify` preserves key insertion order, so
two objects with the same content in the same insertion order
serialize identically. Objects built by the agent LLM will
typically have consistent key orders across turns (the system
prompt shape steers it), so this is good enough. A canonical
sort would be safer at ~zero cost — but it hasn't been needed.
Named as a known bound rather than a bug.

#### The TTL check

`bloomreach-data-source.ts:145-152`:

```ts
const ttl = options.cacheTtlMs ?? 60_000;

if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

**60s default TTL.** Chosen because a single investigation runs
~100–115s (comment at `route.ts:21-22`) — so a repeat call within
one investigation always hits the cache; a repeat call between
investigations may or may not, depending on gap timing. The
60_000 is a defaulted-not-a-constant: callers can pass
`cacheTtlMs` in `CallToolOptions` (`bloomreach-data-source.ts:23`)
but nothing currently does. The agents pass only `signal`, the
comment at `:21-22` notes.

**`durationMs: 0` on cache hit.** Cached responses report zero
latency. That's the honest value for a map lookup, and it's what
lets downstream code (receipts, logs) tell the difference between
"real fast call" and "cache hit."

#### The skip-cache write-through

`bloomreach-data-source.ts:183-186`:

```ts
// Note: a skipCache call still refreshes the cache (write-through), which is
// the desired behavior for the /debug "force fresh" path.
const now = Date.now();
this.cache.set(cacheKey, { result, expiresAt: now + ttl });
```

**What "write-through" means here.** `skipCache: true` skips the
READ (goes to the network) but still writes the fresh result into
the cache. The next call with the same args (skipCache false) gets
the fresh entry. This is what makes the `/debug` "force fresh"
button in the UI both useful (guaranteed fresh) AND non-disruptive
(subsequent duplicate calls stay cheap).

#### The eviction model — implicit

There is no explicit eviction. Expired entries stay in the map
until they're overwritten by a fresh write on the same key, or the
process exits. For request-scoped adapters and Vercel serverless
this is a non-issue — the process dies before the map grows. For a
long-lived instance this would leak. Named as a design choice
tied to the deployment model.

### Move 3 — the principle

Cache what's deterministic within a stable window; don't cache
errors. Errors are transient by definition — the whole point of
retrying is that the next attempt might succeed. Caching an error
transforms a transient failure into a sticky one, so the guard is
load-bearing, not decorative. This lesson generalizes: any
memoization layer needs to distinguish success from failure and
apply the memoization only to the class that's actually
memoizable.

## Primary diagram

```
  Full path of one tool call through the response cache

  callTool(name, args, options)
        │
        ▼
  cacheKey = `${name}:${JSON.stringify(args)}`
  ttl     = options.cacheTtlMs ?? 60_000
        │
        ▼
  skipCache?   ─── yes ───►  go to liveCall directly
        │
        no
        ▼
  cached = cache.get(cacheKey)
        │
        ▼
  cached && cached.expiresAt > Date.now()?
        │                        │
       yes                      no (miss or expired)
        │                        │
        ▼                        ▼
  return { result,      spacing gate → liveCall → transport
    durationMs: 0,               │
    fromCache: true }            ▼
                            result = await…
                                 │
                                 ▼
                          (retry ladder if 429; caps at 3 retries)
                                 │
                                 ▼
                          isError?  yes ── return without caching
                                    no
                                    ▼
                          cache.set(cacheKey, {result, now + ttl})
                          return { result, durationMs, fromCache: false }
```

## Elaborate

**Where the pattern comes from.** TTL-bounded in-process
memoization is one of the oldest software patterns —
`lru-cache`, `memoize-one`, Guava's `CacheBuilder`, Python's
`functools.lru_cache`. The specific choice here — `Map` +
`expiresAt` — is the minimum viable shape. Trading in
`lru-cache` would add a size bound (protecting against unbounded
growth in a long-lived process) at the cost of eviction bookkeeping
per get. For the current shape (per-request adapter, ~10s of tool
calls) it's not worth the dependency.

**Cross-link.** `study-system-design` walks WHY the cache is
per-instance and not distributed — the Vercel constraint, the
portfolio-scale traffic, the "correct enough for now" tradeoff.
This file measures what the local cache buys; that one defends
the architectural choice.

## Interview defense

### Q1 · "Walk me through your response cache."

**Answer.** Instance-local, TTL-bounded, keyed by `(name,
JSON.stringify(args))`. Default TTL is 60 seconds — chosen because
a single investigation runs ~100 seconds, so any repeat call
within one investigation gets a hit. On a hit, we skip the 1.1
second spacing gate, the network round trip, AND we don't consume
one of Bloomreach's ~1 req/s credits. Errors are NOT cached — the
`isError` check gates the write — so a transient 429 doesn't
poison the next 60 seconds of duplicate calls. `skipCache: true`
is write-through: it skips the read but refreshes the entry, so
the `/debug` "force fresh" button doesn't blow the cache for
everyone else.

```
  cache scope    │ per-BloomreachDataSource instance (per-request)
  cache key      │ `${name}:${JSON.stringify(args)}`
  TTL            │ 60_000ms default, overridable per-call
  eviction       │ lazy on read; expired entries stay until overwritten
  errors         │ NOT cached — transient failures don't poison
  skipCache      │ write-through — force-fresh but keep next call fast
```

**One-line anchor.** "60s TTL memoization, keyed by args JSON,
errors not cached, write-through on skipCache."

### Q2 · "What if two args objects have keys in different orders?"

**Answer.** `JSON.stringify` preserves insertion order, so
`{a: 1, b: 2}` and `{b: 2, a: 1}` produce different strings and
therefore different cache keys. In the current setup, the agent
LLM produces args with consistent orderings across turns of the
same investigation (the system prompt shape steers it), so this
hasn't caused misses in practice. If it started to, the fix is a
canonical sort in the cacheKey builder — 5 lines, zero behavior
change for callers. It's a known bound, named as such rather than
patched preemptively.

**One-line anchor.** "Args key order matters; canonical sort is the
straightforward fix if hit rate ever drops."

### Q3 · "Why 60 seconds specifically?"

**Answer.** A live investigation runs ~100–115s under the ~1 req/s
Bloomreach limit. 60 seconds is short enough that the cache holds
during one investigation and mostly expires between investigations
(so we're not serving stale analytics data), long enough that the
mid-investigation repeats hit. It's a defaulted parameter, not a
constant — `CallToolOptions.cacheTtlMs` lets callers override.
Nothing overrides today, but the seam exists.

**One-line anchor.** "60s covers one investigation, expires
between; defaulted-not-constant so callers can dial it."

### Q4 · "What breaks if you cache errors?"

**Answer.** The classic "cascading failure amplifier." A single 429
gets cached; every duplicate call within 60s gets an instant "rate
limited" response without ever hitting the server. The retry
ladder in the next call sees a "cached failure" and might not
even fire (because there's no new server response to parse a
retry-after from). So one transient failure becomes 60 seconds of
guaranteed failure — the exact opposite of what caching is for.
The `isError` guard is one line, but it's the one line that keeps
the cache useful when things go wrong.

**One-line anchor.** "Caching an error turns a blip into a
60-second outage."

## See also

- `02-spacing-gate-and-retry-ladder.md` — the layer below,
  which the cache lets you skip entirely on hits.
- `03-prompt-caching-ephemeral-breakpoint.md` — the parallel
  cache at the model-call boundary (different scope, same idea).
- `study-system-design` — the argument for per-instance vs
  distributed caching.
- `study-database-systems` — the general theory of cache
  invalidation, TTL vs event-driven, write-through vs
  write-behind.

# Response cache with no-cache-on-error — `cacheTtlMs = 60_000`

**Industry standard / Language-agnostic**

A per-instance `Map<cacheKey, { result, expiresAt }>` on the data-source
adapter absorbs repeated MCP tool calls for 60 seconds, with one critical
discipline: **error results are never written to the cache**. This is the
throughput multiplier that lets the spacing gate matter less on the common
path — and the no-cache-on-error rule prevents a single bad call from
poisoning the next minute of retries.

## Zoom out — where this concept lives

The cache sits as the first thing `callTool` checks, before the spacing
gate, before the retry ladder, before any network work happens. A hit
returns synchronously with `durationMs: 0, fromCache: true`.

```
  Zoom out — where this concept lives

  ┌─ Agent layer ───────────────────────────────────────┐
  │  agent loops call dataSource.callTool(name, args)   │
  │  (same name+args often hit during one investigation)│
  └─────────────────────────┬───────────────────────────┘
                            │
  ┌─ Adapter layer ─────────▼───────────────────────────┐
  │  BloomreachDataSource.callTool                       │
  │   1. ★ CACHE CHECK ★    ← we are here               │
  │   2. liveCall (spacing gate)                        │
  │   3. retry ladder                                   │
  │   4. cache.set ONLY if NOT isError                  │
  └─────────────────────────┬───────────────────────────┘
                            │  (only on miss)
  ┌─ Provider ──────────────▼───────────────────────────┐
  │  Bloomreach loomi connect MCP server                 │
  └─────────────────────────────────────────────────────┘
```

## The structure pass

The right axis to trace is **"what costs zero on the second call?"** — and
where the answer flips depending on success vs failure.

```
  axis = "what's the cost of the second identical call?"

  ┌─ first call (success) ──────────────────────────────┐
  │  spacing wait + network + provider work             │
  │  cost: ~1-3s typical                                │
  │  → write to cache                                   │
  └────────────────────────┬────────────────────────────┘
                           │  60s window
  ┌─ second call (cache hit) ───────────────────────────┐
  │  Map.get + Date.now compare                         │
  │  cost: 0ms wall-clock, 0 MCP requests               │
  │  → return cached result                             │
  └─────────────────────────────────────────────────────┘

  ┌─ first call (error, e.g. 429 retries exhausted) ────┐
  │  spacing wait + network + provider error            │
  │  cost: ~12-50s (retries)                            │
  │  → DO NOT write to cache  ← the load-bearing rule   │
  └────────────────────────┬────────────────────────────┘
                           │  next call, immediately
  ┌─ second call (cache MISS by design) ────────────────┐
  │  full spacing wait + network + retry ladder again   │
  │  cost: ~1-50s — gets a fresh shot                   │
  └─────────────────────────────────────────────────────┘
```

The seam where success vs failure flips behavior is the line that decides
whether to write to the cache. On the success side, the cache amortizes
cost across all callers in the 60s window. On the failure side, the
no-cache discipline guarantees the next caller doesn't inherit the failure.

## How it works

### Move 1 — the mental model

You've used React Query / SWR — a `useQuery(key)` with a `staleTime` returns
the previous data instantly on the second call, then refetches in the
background after the TTL. This cache is the same shape, simpler: synchronous
`Map.get`, fixed 60s TTL, no background refetch, no stale-while-revalidate.
The simplicity is appropriate — the agent loop doesn't have a UI to keep
fresh, it just wants the value back.

```
  The pattern — TTL cache with a no-cache-on-error gate

  state: Map<cacheKey, { result, expiresAt }>

  on each call:

      cacheKey = name + JSON.stringify(args)
            │
            ▼
      cached = cache.get(cacheKey)
            │
        cached && expiresAt > now?
       ┌────┴────┐
      yes        no
       │          │
       ▼          ▼
   return     result = liveCall + retry ladder
   cached         │
                  ▼
            result.isError ?
           ┌────┴────┐
          yes        no
           │          │
           ▼          ▼
       skip cache  cache.set(key, { result, expiresAt: now + ttl })
       return         return
```

Kernel: a `Map`, a TTL check, and one branch that gates the write on
`!isError`. Remove the no-cache-on-error branch and you've got a normal TTL
cache; with it, you've got a cache that won't poison itself.

### Move 2 — the walkthrough

#### The cache map and key

The cache lives on the `BloomreachDataSource` instance, which is per-request.
Production scoping is therefore "one map per HTTP request" — never shared
across users, never persists past the request.

```ts
// lib/data-source/bloomreach-data-source.ts:121-122
export class BloomreachDataSource implements DataSource {
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
```

The key composes the tool name with a JSON-stringified args object:

```ts
// lib/data-source/bloomreach-data-source.ts:144
const cacheKey = `${name}:${JSON.stringify(args)}`;
```

**What breaks if you key on tool name alone.** `execute_analytics_eql` with
two different EQL queries would collide — the second caller gets the first
caller's result. Including the args is what makes the key actually identify
the call.

**What breaks if you stringify in a non-stable order.** `{a:1,b:2}` and
`{b:2,a:1}` would produce different keys for the same logical call.
`JSON.stringify` preserves insertion order — fine when the callers always
build args the same way, which is true in this codebase (agents always
build args from a template). If two call sites started building the same
args in different orders, you'd want a deterministic stringifier.

#### The cache check

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

Three observations on this small block:

1. **`durationMs: 0`** is the honest answer — we didn't wait, we didn't
   network, we returned synchronously. Surfacing it lets the agent's tool
   trace distinguish cache hits visually (`fromCache: true` flag too).
2. **`options.cacheTtlMs ?? 60_000`** — per-call override, defaulting to
   60s. Used by the 4 short MCP routes (`app/api/mcp/{call,tools,tools/check,capture}/`)
   for tuning per use case; agents always use the default.
3. **`!options.skipCache`** — a hard bypass switch. Used by the debug route
   and the capture path when they need a fresh fetch regardless of what's
   cached. Notice: skipCache still **writes** to the cache after the live
   call returns (line 184-186) — the comment at lines 183-184 calls this
   out explicitly. So skipCache means "force-fresh on this read," not
   "don't participate in the cache at all."

**What breaks without the TTL check.** Stale data leaks across minutes; a
metric computed at 10:00 still serves at 10:30. With it: every 60s the
cache invalidates itself naturally, which matches the typical investigation
window.

#### The no-cache-on-error rule

This is the line that earns this file its name:

```ts
// lib/data-source/bloomreach-data-source.ts:178-188
const durationMs = Date.now() - start;

// Don't cache error results — they should not poison the cache.
if ((result as any)?.isError === true) {
  return { result: result as T, durationMs, fromCache: false };
}

// Note: a skipCache call still refreshes the cache (write-through), which is
// the desired behavior for the /debug "force fresh" path.
const now = Date.now();
this.cache.set(cacheKey, { result, expiresAt: now + ttl });
return { result: result as T, durationMs, fromCache: false };
```

The comment is doing real work. Without this gate, here's what happens:

```
  Execution trace — what no-cache-on-error prevents

  t=0     callTool("execute_analytics_eql", {…}) → 429 → retries 3x → still 429
                isError: true returned
                IF CACHED: written to cache with 60s TTL
  t=1s    next call comes in to same name+args
                IF CACHED: hits the poisoned entry, returns isError immediately
                no MCP call attempted, no chance for the situation to recover
  t=2s    next call, same thing
  ...
  t=60s   cache entry expires, finally retries → succeeds

  → 60 seconds of dead time on every call that matches the poisoned entry
  → user sees errors for a full minute even though the provider recovered

  WITH no-cache-on-error:
  t=0     same failure, NOT cached
  t=1s    next call → spacing wait → retry ladder fresh shot → succeeds
  → recovery in ~1-2s, not 60s
```

**What breaks without this rule.** Cache poisoning. A single bad call locks
out the value for 60 seconds. Worst when the failure is transient (one bad
minute on the provider's side) and the cache TTL exceeds the failure
window — the failure window is over in 10s, but the cache holds the error
for 50 more.

#### How this composes with the retry ladder

The retry ladder (see `02-rate-limit-retry-ladder.md`) sits *between* the
cache check and the cache write. So:

- A cached hit short-circuits before the retry ladder runs.
- A miss runs the retry ladder; if it succeeds, the success is cached for
  60s.
- A miss whose retries are exhausted returns isError; the no-cache-on-error
  gate prevents the write.

```
  Layers-and-hops — call lifecycle with cache + retry ladder

  callTool:
   │
   ├─ cache.get → hit?  YES → return { fromCache: true, durationMs: 0 }
   │              │
   │              NO
   │              ▼
   ├─ liveCall (spacing gate) → result
   │
   ├─ while isRateLimited: parse hint, sleep, retry
   │
   ├─ result.isError?  YES → return without caching
   │                   │
   │                   NO
   │                   ▼
   └─ cache.set(key, { result, expiresAt: now + 60s })
      return result
```

#### What the cache actually amortizes

Look at what the agents call repeatedly:

- `get_event_schema`, `get_customer_property_schema`, `list_catalogs`,
  `get_project_overview` — the four bootstrap calls (`lib/mcp/schema.ts:195-198`).
  Each agent that starts in the same minute as another reuses these. The
  module-level schema cache (`lib/mcp/schema.ts:138`) is the bigger absorber
  for these specifically, but the response cache backs it up.
- `execute_analytics_eql` — when the monitoring agent computes a metric and
  the diagnostic agent later wants the same metric to confirm a hypothesis,
  the cache returns it instantly. Same when two anomaly categories happen
  to need the same baseline window.
- `list_tools` — called by both routes; cached across agent steps inside the
  same request.

**The numbers nobody has measured.** What percentage of MCP calls are cache
hits in a typical investigation? The phase log doesn't break it out, the
`fromCache: true` field is set but isn't aggregated. This is one of the
clearest holes in the perf instrumentation — measuring it would tell you
whether to widen the TTL (more hits, more stale risk) or shrink it (fewer
hits, more freshness).

### Move 3 — the principle

The principle: **a cache must distinguish "absent" from "known to be
bad."** A normal TTL cache treats them the same — both lead to a refetch
when the entry expires. A cache without a no-cache-on-error gate treats
"known to be bad" as "valid until TTL," which is exactly wrong — the bad
result is the one you most want to retry, not the one you most want to
serve again.

A useful generalisation: **any cache that fronts a flaky source needs an
explicit policy on what counts as a cacheable result.** Defaults vary:
HTTP caches gate on status code (5xx not cached); React Query gates on the
`queryFn` throwing (errors hold a separate `error` state, not the `data`
slot); this cache gates on `result.isError`. Pick the gate that matches
how your source reports failure, and write it down.

## Primary diagram

```
  Response cache — full picture

  state per BloomreachDataSource (one per request):
    cache: Map<"toolName:{args}", { result, expiresAt }>
    minIntervalMs: 1100
    retry config: maxRetries=3, retryDelayMs=10_000, retryCeilingMs=20_000

  callTool(name, args, options):
   │
   ├─ cacheKey = name + JSON.stringify(args)
   ├─ ttl = options.cacheTtlMs ?? 60_000
   │
   ├─ if !options.skipCache:
   │    cached = cache.get(cacheKey)
   │    if cached && cached.expiresAt > now:
   │      return { result: cached.result, durationMs: 0, fromCache: true }
   │
   ├─ start = Date.now()
   ├─ result = liveCall(name, args, signal)    ← spacing gate runs here
   │
   ├─ while isRateLimited(result) && retries < 3:
   │    waitMs = min(parsedHint + 500 ?? backoff, 20_000)
   │    sleep(waitMs)
   │    result = liveCall(name, args, signal)
   │
   ├─ durationMs = Date.now() - start
   │
   ├─ if result.isError === true:
   │    return { result, durationMs, fromCache: false }    ← NO CACHE WRITE
   │
   ├─ cache.set(cacheKey, { result, expiresAt: now + ttl })
   └─ return { result, durationMs, fromCache: false }
```

## Elaborate

**Where this pattern comes from.** TTL caches with negative-result handling
are old — Squid (HTTP cache, 1996) had explicit `negative_ttl` for failed
responses. The HTTP spec (RFC 9111 §3) distinguishes cacheable status codes
from non-cacheable. The novelty here is just the gate condition: instead of
"check the HTTP status," it's "check `isError` in the unwrapped MCP
envelope," because the MCP layer hides the underlying HTTP status from us.

**Why per-request, not module-level.** A module-level cache would persist
across requests in a warm serverless instance — and across users. Per-user
scoping would require keying every cache entry with a `sessionId`, doubling
the key surface and risking accidental cross-tenant data leakage if the
keying is ever wrong. Per-request scoping is foolproof: the cache dies with
the request that created it, no cross-tenant possibility, at the cost of
not amortizing across multiple requests for the same user.

The module-level schema cache (`lib/mcp/schema.ts:138`) deliberately makes
the *opposite* trade: schema is workspace-level, not user-level, so a single
cached `WorkspaceSchema` is correct across users for the same workspace.
That choice is correct because the bootstrap is expensive (4 sequential
calls under the spacing gate ≈ 5-6s) and the value is large-grained.

**Why 60s, not 300s.** Long enough that an investigation's calls overlap
inside one window. Short enough that the data is fresh — Bloomreach metrics
update continuously, and serving 5-minute-old anomaly numbers in a
"monitoring" product is the wrong product behavior. 60s is the typical
investigation window: bootstrap → 4 calls → diagnostic → 6-10 calls →
recommendation → 4-6 calls, all under 90s typically.

**The unbounded `Map` risk.** No LRU cap, no max size. Per-request scoping
bounds production fine — the worst case is a single investigation's worth
of unique calls, which is on the order of tens of entries. The dev risk is
a long-running `npm run dev` server re-using the same `BloomreachDataSource`
instance across requests if you ever break the per-request construction;
the design currently prevents that, but the cache itself wouldn't notice.
Address with `Map` → simple ring buffer or `lru-cache` if you ever hit it.

## Interview defense

**Q: Walk me through your caching strategy.**

The data-source adapter holds a per-request `Map` of MCP tool results, keyed
on `name + JSON.stringify(args)`, TTL 60 seconds. On every `callTool` we
check the map first — hits return synchronously with `durationMs: 0` and a
`fromCache: true` flag so the trace can show they didn't touch the network.
On a miss we run the spacing gate, the live call, the retry ladder, and
then — only if the result isn't an error — write to the cache.

The discipline that earns the file its name is **no-cache-on-error**.
Without it, a 429 that the retry ladder couldn't recover would get cached
for 60s, locking out the value while the provider may have already
recovered. With it, the next call gets a fresh shot through the retry
ladder — typical recovery is ~1-2s instead of waiting 60s for the cache
entry to expire.

```
  Sketch — the two writes

  on success:  cache.set(key, { result, expiresAt: now + 60s })
  on error:    return result, NO cache write
```

Anchor: `lib/data-source/bloomreach-data-source.ts:144-188`.

**Q: What's the load-bearing part most people forget?**

The no-cache-on-error gate. A normal TTL cache wraps everything; the gate
is the line that decides whether to write. Skip it and you've built cache
poisoning into the design. The test that catches it: simulate a failing
provider for one minute, then make it healthy again, and watch how long
until your first successful call returns. Without the gate: 60 seconds.
With it: the next call.

**Q: Why per-request scoping instead of module-level?**

Per-request makes cross-tenant leakage impossible. Module-level would
require keying every entry with a `sessionId` and trusting the keying — and
trusting the keying is exactly the kind of thing you should not have to
trust when the cost of being wrong is showing user A's data to user B. The
amortization loss is acceptable because the agent loops inside a single
request hit the same calls multiple times — that's where the cache earns
its keep.

The module-level schema cache makes the opposite trade because the schema
is workspace-level, not user-level — sharing across users in the same
workspace is correct.

## See also

- `01-spacing-gate-vs-backpressure.md` — the cache is what makes the
  spacing gate matter less for the common (repeat) path.
- `02-rate-limit-retry-ladder.md` — the retry ladder runs between the cache
  check and the cache write; this file explains why its exhausted-error
  result must not be cached.
- `../study-database-systems/` — TTL cache patterns generalise to query
  caches, plan caches, materialized-view caches.
- `../study-debugging-observability/` — the `fromCache: true` field is the
  signal you'd use to measure hit rate.

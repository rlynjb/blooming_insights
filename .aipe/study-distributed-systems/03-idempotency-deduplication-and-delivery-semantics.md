# idempotency-deduplication-and-delivery-semantics

*Deduplication cache · At-least-once semantics · Read-only tools · Industry standard*

## Zoom out — where this concept lives

This is the file where you have to be honest about what "delivery
semantics" means in a repo where the only external side effect is a
read-only EQL query. There IS a dedup surface here (the 60s cache), and
the retry ladder DOES produce at-least-once execution — but because the
tools don't mutate anything, at-least-once and exactly-once are
observationally identical. That is the load-bearing insight.

```
  Zoom out — dedup and delivery live in the adapter

  ┌─ Client layer ──────────────────────────────────┐
  │  no dedup — every fetch() opens a fresh stream  │
  └───────────────────────┬─────────────────────────┘
                          │
  ┌─ Service layer ───────▼─────────────────────────┐
  │  ★ THE 60s CACHE + RETRY LADDER LIVE HERE ★     │ ← we are here
  │                                                  │
  │  BloomreachDataSource                            │
  │  - cache: Map<name+args, {result, expiresAt}>    │
  │  - retry ladder (at-least-once execution)        │
  │  - no-cache-on-error (poison guard)              │
  └───────────────────────┬─────────────────────────┘
                          │  hop B — Bloomreach
                          ▼
  ┌─ Provider ──────────────────────────────────────┐
  │  execute_analytics_eql · all read-only           │
  │  no idempotency-key protocol offered             │
  └─────────────────────────────────────────────────┘
```

## Structure pass

### Layers of "is this a duplicate?"

```
  What "duplicate" means, at three layers

  ┌───────────────────────────────────────────────┐
  │ agent (model)                                  │
  │   "duplicate" = same tool + same args in the   │
  │    same investigation. Cache absorbs; model    │
  │    sees the cached result.                     │
  └───────────────────────────────────────────────┘
      ┌───────────────────────────────────────────────┐
      │ adapter (BloomreachDataSource)                │
      │   "duplicate" = same name+args within 60s.    │
      │   Cache key = `${name}:${JSON.stringify(args)}`│
      │   (bloomreach-data-source.ts:144)             │
      └───────────────────────────────────────────────┘
          ┌───────────────────────────────────────────┐
          │ provider (Bloomreach)                     │
          │   "duplicate" = doesn't exist in the      │
          │    protocol. Bloomreach doesn't dedup.    │
          │    Every call is a new EQL execution.     │
          └───────────────────────────────────────────┘
```

The answer flips at every layer. At the agent, dedup is a latency win. At
the adapter, dedup is a rate-limit win. At the provider, there IS no
dedup — every EQL call re-executes on their side.

### One axis — trace "how many times can this side effect happen?"

```
  "how many times can this call's side effect happen?"

  ┌───────────────────────────────────────────────┐
  │ EQL queries via execute_analytics_eql          │
  │   → 0 side effects (read-only)                 │  at-least-once == exactly-once
  │   → duplicate calls just re-compute            │  OBSERVATIONALLY
  └───────────────────────────────────────────────┘
      ┌───────────────────────────────────────────┐
      │ HYPOTHETICAL: campaign_send tool           │
      │   → N side effects if called N times       │  at-least-once ≠ exactly-once
      │   → would need idempotency key             │  NEEDS PROTOCOL SUPPORT
      └───────────────────────────────────────────┘
```

The current answer is "0 side effects" for every tool the agents actually
call — the monitoring/diagnostic loop reads only. That's why the retry
ladder is safe and the cache is a pure win. **The moment a tool that
mutates ships (voucher issue, campaign send, segment update), this
axis flips and every mechanism in this file needs revisiting.**

### Seams

- **Cache key seam** — `${name}:${JSON.stringify(args)}` at
  `bloomreach-data-source.ts:144`. If args come back in a different key
  order, `JSON.stringify` produces different keys and the cache misses.
  Not a bug today (Anthropic sends the same arg shape on each turn), but
  a landmine.
- **The `isError: true` guard** at `bloomreach-data-source.ts:179-181` —
  the seam where "should this result enter the cache?" is decided. This
  is the only distinction between cached and uncached responses; if
  removed, an error envelope would be cached and every subsequent call
  within 60s would return the error without trying.

## How it works

### Move 1 — the mental model: at-least-once + read-only = observationally exactly-once

You know how HTTP GET requests are supposed to be idempotent — you can
retry them safely because they don't mutate anything? Same idea here,
but explicitly: **every tool the agents call is a read-only EQL query
or a schema introspection.** So retry is safe by construction.

```
  The pattern — read-only tools make at-least-once free

     agent calls tool
           │
           ▼
     cache HIT (within 60s) ────► return cached result   at-most-once
                                  (side effect: 0)         within window
           │
           ▼
     cache MISS ────► liveCall  ────► success ────► cache write, return
                                       │              side effect: 0
                                       │              (read-only)
                                       ▼
                                     failure
                                       │
                                       ▼
                                   retry ladder ────► success on retry N
                                                      side effects: N × 0 = 0
                                                      OBSERVATIONALLY = 1 call

  because every call has 0 side effects on Bloomreach's side,
  N calls and 1 call look identical to the world.
```

The lesson: the reason the retry ladder is safe is not that it retries
carefully. It's that the tools it retries have no side effects worth
worrying about.

### Move 2 — walk the mechanism

#### The 60s cache — dedup within a warm instance

Every successful tool result is cached for 60 seconds keyed by
name+args:

```typescript
// lib/data-source/bloomreach-data-source.ts:139-188 (excerpt)
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
  // ... liveCall + retry ladder
  if ((result as any)?.isError === true) {
    return { result: result as T, durationMs, fromCache: false };  // NO CACHE
  }
  const now = Date.now();
  this.cache.set(cacheKey, { result, expiresAt: now + ttl });
```

Bridge: this is the exact shape of `useMemo` in React — a cache keyed by
inputs. The differences: the key is `name+JSON.stringify(args)`, TTL is
time-based not deps-based, and there's the load-bearing `isError` guard.

**Load-bearing part: the `isError` early-return at `:179-181`.** Without
it, an error result would enter the cache under the same key as a
successful result. A transient 401 (token revoked mid-investigation)
would then be returned from cache for the next 60s to every retry — the
retry ladder wouldn't even see fresh errors because it'd get the cached
one. This is the "poison-cache" failure mode, and this three-line early
return is the guard.

The `fromCache: true` marker (`:151`) rides through the whole stack up
to the UI's "how it was gathered" panel — so a cache hit is visible in
the trace, not silent.

#### The retry ladder produces at-least-once

Section 02 walked the retry ladder in detail. The delivery-semantics
angle: **each retry is a fresh call to the transport**, so a call that
succeeds on attempt 3 has executed on Bloomreach's side 3 times.

Trace it:

```
  Retry ladder as a delivery-semantics view

  attempt 1 → transport.callTool → 429   → 1 execution on Bloomreach
  wait 10.5s
  attempt 2 → transport.callTool → 429   → 2nd execution
  wait 10.5s
  attempt 3 → transport.callTool → 200   → 3rd execution
  ─────────────────────────────────────────
  agent sees:  1 successful result
  Bloomreach:  3 EQL executions

  → at-least-once from the agent's POV
  → 3× the compute on Bloomreach's side
  → 0 side effects (because EQL is read-only)
```

The Bloomreach side pays 3× compute cost for a call that got throttled
on the first two attempts. This is a real cost — the retry ladder is
NOT free, it's paid on the provider's side even when we retry
identically. **Which is one reason `minIntervalMs=1100` exists**: better
to space out and pay 1× compute per call than to burn 3× compute per
rate-limited call.

#### What "duplicate" looks like across two warm Vercel instances

Vercel serverless functions are ephemeral. Two warm instances serving
the same user each have their own `BloomreachDataSource.cache` Map
(`bloomreach-data-source.ts:122`). Same investigation, request routed
to instance A, then a follow-up request to instance B — the cache is
cold on B.

```
  Cache locality across warm instances

  Request 1 → Instance A → cache MISS → liveCall → cache SET → response
                                                    (60s TTL on A)
  Request 2 → Instance A → cache HIT (within 60s)   → response
                                                    (fast)
  Request 3 → Instance B → cache MISS (B is cold)   → liveCall
                                                    (repeats the work)
```

The "duplicate" is dedup'd within an instance, not across them. There is
no shared cache. This is fine for this system because:

- investigation runs are self-contained (one request opens one stream,
  never crosses two instances)
- the 60s TTL is short enough that cross-instance duplication is bounded
- the demo path (`?demo=cached`) bypasses this entirely by replaying a
  file-based snapshot

#### `skipCache: true` — the write-through path

`/api/mcp/call?skipCache=true` (and the debug tooling) bypasses the read
but still writes on success:

```typescript
// bloomreach-data-source.ts:184-187 (excerpt)
// Note: a skipCache call still refreshes the cache (write-through), which is
// the desired behavior for the /debug "force fresh" path.
const now = Date.now();
this.cache.set(cacheKey, { result, expiresAt: now + ttl });
```

The comment names the tradeoff explicitly. Debug tooling wants "make me a
fresh call" but shouldn't leave the cache stale for the next non-debug
caller. Write-through gives both.

### The skeleton — what "duplicate" and "delivery" reduce to

Isolate the kernel of dedup+delivery in this repo. The pattern is:
"read-only tools + cache-on-success + retry-safe-because-idempotent."

What breaks without each part:

- **Drop the cache** — every repeat call goes to Bloomreach. 3× the
  rate-limit pressure, 3× the compute cost on their side, same
  behavior on ours. Doesn't break correctness; kills the budget.
- **Drop `isError` guard on the cache write** — a transient 401 poisons
  the cache for 60s; every subsequent call within the window returns
  the same 401. Breaks recovery (the retry ladder can't help because
  the cache short-circuits before it runs).
- **Drop the read-only constraint on tools** — every retry has real
  side effects. `campaign_send` runs 3 times, sends 3 emails.
  **Everything about at-least-once semantics needs revisiting.**
- **Drop the `fromCache: true` marker** — cache hits are invisible to
  the trace. UI still works; observability breaks (you can't tell in
  a receipt whether the investigation used cached or fresh data).

### Optional hardening layered on top

- **`cacheTtlMs` per-call override** at `bloomreach-data-source.ts:145`
  — most calls use 60s but a caller can pass its own TTL. Used by the
  `/api/mcp/tools/check` route which wants a shorter TTL for the
  tool-list sanity check.
- **`fromCache: false` on error** — `bloomreach-data-source.ts:180` sets
  `fromCache: false` on the error return path even though nothing was
  actually cached. This is deliberate: it means "this result did NOT
  come from cache," which is true.

### Move 3 — the principle

**"At-least-once vs exactly-once" is only interesting when the
operation has a side effect worth counting.** In a read-only system,
the delivery-semantics conversation collapses to "is the retry safe?"
and the answer is trivially yes. The moment a mutating tool ships, this
whole file gets rewritten around idempotency keys and dedup tokens.
The current architecture ISN'T wrong for not having those — it's
correctly not having them, because it doesn't need them. Recognize
which side of that line you're on before you build the machinery.

## Primary diagram — the dedup + delivery picture

```
  60s cache + at-least-once retry ladder, one frame

  agent.callTool('execute_analytics_eql', { eql })
                        │
                        ▼
     ┌──────────────────────────────────────────────┐
     │ cacheKey = `${name}:${JSON.stringify(args)}` │
     └────────────┬─────────────────────────────────┘
                  │
      ┌──── HIT (within 60s) ────┐
      │                          │
      ▼                          ▼
  return {                MISS: fall through
    result,              │
    durationMs: 0,       ▼
    fromCache: true      liveCall → transport.callTool
  }                      │
                         │       ┌── success ─────┐
                         │       │                │
                         │       ▼                ▼
                         │   isRateLimited?     !isError
                         │       │                │
                         │       ▼                ▼
                         │   retry ladder     cache.set(key,
                         │   (at-least-once)  { result, expiresAt })
                         │       │                │
                         │       │                ▼
                         │       ▼           return uncached
                         │   fresh result      {fromCache: false}
                         │
                         │       ┌── failure ─────┐
                         │       │                │
                         │       ▼                ▼
                         │   isError: true     RETURN UNCACHED
                         │   in envelope       (poison-cache guard)
                         │       │
                         │       ▼
                         │   { result, durationMs, fromCache: false }
                         │   → AptKit wraps as tool_result is_error:true
                         │   → model reasons about it (band 4 in file 02)
```

## Elaborate

Where this pattern shows up elsewhere: React Query's cache-then-refetch,
SWR's stale-while-revalidate, GraphQL client normalized caches. All the
same shape: a key derived from inputs, a TTL, a policy on what to do
with errors. This file's `isError` guard is the same idea as React
Query's `retryOnMount: false` for failed queries.

Where this pattern breaks in a real distributed system:

- **Idempotency keys** — a real payment API takes an
  `Idempotency-Key: <uuid>` header from the client, and the server
  dedups requests with the same key. The retry is safe because the
  server IS aware of duplicates. Bloomreach doesn't offer this
  protocol, but since the tools are read-only it doesn't matter.
- **Exactly-once delivery** — the standard result is that
  exactly-once is impossible with independent participants;
  the practical achievement is at-least-once + idempotent
  operations, which gives you effectively-exactly-once. That is
  exactly this system's stance, arrived at not by protocol but by
  "the tools happen to be read-only."

The Week 4B fault-injection story crosses this file too: `malformed_json`
is a fault mode where the CALL succeeded (from Bloomreach's POV) but
the CONTENT is broken (from our POV). At-least-once execution
completed; the agent's downstream parse rejects it. So the retry
happens at the agent-loop / model layer, not at the adapter. The
delivery boundary is the model's tool-result interpretation, not the
transport's HTTP status.

## Interview defense

### Q: "What are your delivery semantics?"

Sketch this:

```
  at-least-once execution
         +
  read-only tools
  ────────────────
  observationally exactly-once
```

"At-least-once at the transport, because the retry ladder makes each
retry a fresh call. But every tool the agents call is read-only —
`execute_analytics_eql`, schema introspection — so N executions and 1
execution look identical to the world. Observationally exactly-once, by
construction. The 60s cache on top of that dedups within a warm
instance, keyed by `${name}:${JSON.stringify(args)}` — that's a
latency win, not a correctness one. The moment we ship a mutating tool
(voucher issue, campaign send), we'd need idempotency keys and this
whole file would get rewritten."

Anchors: `bloomreach-data-source.ts:144` (cache key),
`bloomreach-data-source.ts:163-174` (retry ladder),
`bloomreach-data-source.ts:179-181` (poison-cache guard).

### Q: "What breaks if you delete the `isError` early return?"

"A transient 401 gets cached for 60s. Every subsequent call within the
window returns the same 401 from cache without trying the transport.
The retry ladder never sees a fresh error to retry against. Recovery
takes 60s minimum instead of the next retry."

### Q: "How do you dedup across two warm Vercel instances?"

"You don't, today. Each instance has its own in-memory
`BloomreachDataSource.cache` Map. This is fine because investigation
runs are self-contained (one request opens one stream, never crosses
two instances) and the 60s TTL is short. If we needed cross-instance
dedup, we'd introduce a shared cache (Vercel KV, Upstash Redis) —
that's the standard move. It'd be a distributed-systems complication
we don't need yet."

## See also

- 02-partial-failure-timeouts-and-retries.md — the retry ladder that
  produces the at-least-once execution
- 04-consistency-models-and-staleness.md — the "cache-across-instances"
  problem from the consistency angle
- 09-distributed-systems-red-flags-audit.md — mutating tools as a
  ranked future risk

# TTL cache with no-cache-on-error

**Industry name(s):** TTL cache · result cache · negative-cache avoidance · cache-aside with error bypass
**Type:** Industry standard

> The McpClient cache (`lib/mcp/client.ts:80,102-110,137-145`) is a `Map<string, { result, expiresAt }>` keyed on `${name}:${JSON.stringify(args)}` with a default 60-second TTL. On a hit, it returns `{ durationMs: 0, fromCache: true }` — bypassing **both** the 1.1-second spacing gate AND the network HTTPS round-trip. On a miss, it makes the live call (subject to spacing + retry) and stores the result. The load-bearing design choice is at `lib/mcp/client.ts:137-145`: **errors are NOT cached**. Without that, a rate-limit error would poison the cache for 60 seconds — every subsequent identical call would return the same error until expiry, effectively locking the user out long after the rate limit cleared. This single guard converts the cache from a perf optimization into a perf-and-correctness pattern.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** A cache lives at the *most expensive* part of an I/O path, and its job is to make the question "have I already paid for this?" cheap. For blooming insights, the most expensive I/O is the Bloomreach MCP call: 1.1s spacing floor + 0.5-2.5s network + EQL execution. A cache hit removes *all* of that. A naive cache caches everything that comes back; the problem is that "everything" includes errors — and caching errors is silently worse than not caching at all, because the user pays the error cost long past when the underlying condition cleared.

```
  Zoom out — where the cache lives

  ┌─ Agent loop ─────────────────────────────────────┐
  │  Claude requests tool_use → loop dispatches      │
  │  through McpClient.callTool                      │
  └────────────────────────┬──────────────────────────┘
                           │
  ┌─ Provider/transport ──▼──────────────────────────┐
  │  McpClient.callTool                              │
  │    ★ check cache (this concept) ★                │  ← we are here
  │    │                                              │
  │    ├─ HIT → return { result, durationMs: 0,      │
  │    │              fromCache: true } (~0 ms)      │
  │    │                                              │
  │    └─ MISS → liveCall                            │
  │            spacing gate (~0-1100ms)              │
  │            HTTPS to Bloomreach                   │
  │            retry on 429 (up to 3×)               │
  │         ★ only cache if NOT an error ★           │
  └────────────────────────┬──────────────────────────┘
                           │
  ┌─ External ────────────▼──────────────────────────┐
  │  Bloomreach loomi-mcp · 1 req/s/user rate limit   │
  └───────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *what's the cache's hit/miss math, why is the 60s TTL the right number, and what does the "errors not cached" guard prevent?* The answer is *hit returns 0ms by skipping spacing + network; the 60s TTL is long enough to catch intra-investigation re-derives but short enough to keep cross-investigation data fresh; bypassing the cache for errors prevents a single 429 from locking the user out for a full minute.* Below, you'll see the cache's kernel, the TTL choice, and the error-bypass guard with the failure mode it prevents.

---

## Structure pass

**Layers.** The cache sits at the provider/transport band, between the agent loop (the consumer of tool results) and the network call to Bloomreach. It's invisible to both — the agent doesn't know it exists, the network doesn't know it was skipped.

**Axis: cost paid on hit vs miss.** Hold one question constant across the two paths: *what does this code path cost?* Cost is the right axis for a cache because that's literally its job — to make one path (the hit) much cheaper than the other (the miss). A cache where hits and misses cost the same is broken; a cache where the hit is a near-free property read and the miss is a ~1.5-3s I/O chain is doing its job.

**Seams.** Three load-bearing.

- **C1: hit ↔ miss.** The cache's value-add lives entirely on this seam. Hit returns 0ms (skip spacing + network); miss pays the full cost. The leverage depends on the hit rate.
- **C2: success ↔ error.** The most important seam in this implementation. On success, store. On error, return without storing. Same code shape (return the value), opposite semantic (the error stays transient; the success becomes cached).
- **C3: exact-match ↔ semantic-similar.** The cache uses `JSON.stringify(args)` for keying — exact match only. A semantically similar but byte-different query (different ordering of EQL filters, different whitespace) is a miss. This is deliberate: exact-match has bounded staleness; semantic-similar can be subtly wrong.

```
  Structure pass — TTL cache with error bypass

  ┌─ 1. LAYERS ──────────────────────────────────────┐
  │  Agent loop · Provider/transport · External       │
  │  (cache sits at provider/transport)               │
  └────────────────────────┬─────────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼──────────────────────────┐
  │  cost paid on hit vs miss                         │
  └────────────────────────┬─────────────────────────┘
                           │  trace it across paths
  ┌─ 3. SEAMS ────────────▼──────────────────────────┐
  │  C1: hit ↔ miss          (leverage)               │
  │  C2: success ↔ error     ★ the no-cache-on-error  │
  │  C3: exact ↔ semantic    (key choice)             │
  └────────────────────────┬─────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest walks the cache kernel, the TTL choice, and the error-bypass guard.

---

## How it works

### Move 1 — the mental model

You've put a `useMemo(() => expensive(x), [x])` in a React component — same shape. A cache says "the answer to this question depends on these inputs; if I've already computed it for these inputs, return the same answer." TTL says "if I computed it more than N seconds ago, it might be stale — recompute." The error-bypass guard adds one more axis: "if the answer was an error, don't memoize — try again next time." That last clause is the difference between a cache that helps and a cache that hurts.

```
  Pattern — the cache's kernel (3 parts)

   key:    derived from the request inputs
                "execute_analytics_eql:{\"project_id\":...,\"eql\":...}"
        │
        ▼
   value:  the response, plus an expiry
                { result: <Bloomreach response>, expiresAt: <now + 60_000> }
        │
        ▼
   guard:  on read: check expiresAt > now (not stale)
           on write: check NOT an error (don't poison)

   the kernel:
     READ — check map[key]; if exists and !stale, return (hit)
     MISS — make the live call
     WRITE — if !error, store; otherwise return without storing

   what breaks if a part is missing:
     no key:       wrong answers (cache returns prior call's result)
     no expiresAt: stale data forever
     no read-guard: stale data
     no write-guard: error poisoning (the load-bearing pattern)
```

The model: **a cache is a memoization with a clock and an error-aware write**. The first two parts make it a TTL cache; the third part is what makes it a *correct* cache in the face of transient failures.

---

### Move 2 — the cache kernel, the TTL choice, and the error-bypass

#### Move 2.1 — the kernel: key, store, hit, miss

The cache is a `Map<string, CacheEntry>` initialized in the `McpClient` constructor. Every `callTool` invocation goes through the cache before it can reach the network.

```
  Pattern — the read path (hit and miss)

   on callTool(name, args, options):

     cacheKey = `${name}:${JSON.stringify(args)}`   ← key derivation
                                                      (exact-match — see C3)
     ttl = options.cacheTtlMs ?? 60_000              ← default 60s

     if !options.skipCache:
       cached = map.get(cacheKey)
       if cached and cached.expiresAt > now:
         return { result: cached.result,             ← HIT
                  durationMs: 0,                     ← skip spacing AND network
                  fromCache: true }                  ← signal to the caller

     # falls through to MISS path
     start = now
     result = liveCall(...)                          ← MISS — pay full cost
                                                       (spacing + network + retry)
     durationMs = now - start
     # ... (the write path is the error-bypass guard, see Move 2.3) ...
```

The boundary: **the hit is free** — a property read on a `Map` is single-digit microseconds. The miss is everything: the spacing gate's sleep, the HTTPS round-trip, any retry waits. On a typical investigation where Claude re-derives 2 of 12 tool calls, that's ~3-6s of investigation latency removed, *and* 2 rate-limit slots returned.

#### Move 2.2 — the 60-second TTL (the right setting for this codebase)

The TTL is set to 60 seconds by default. Why specifically 60? Two pressures balance:

```
  Pattern — TTL setting, balancing two pressures

   PRESSURE 1: re-derive frequency within an investigation
     Claude exploring a hypothesis often re-runs the same EQL within seconds
     ("let me check conversion in the last 30 days... ok normal... let me
     re-check the previous 30 days... wait, let me redo the first one for
     comparison")
     hit-rate within a 30-50s diagnostic agent: ~10-30% of calls
     TTL must be LONGER than the typical investigation phase (~30-50s)

   PRESSURE 2: cross-investigation freshness
     a new briefing fired 60s after the prior one should see fresh data
     workspace events land minute-to-minute (in active periods)
     TTL must be SHORTER than the typical re-briefing cadence (~ few min)

   60 seconds is the smallest value satisfying PRESSURE 1
   while still being short enough for PRESSURE 2.

   alternatives:
     10s — would miss the intra-agent re-derives (loss of leverage)
     300s — would carry briefing N's results into briefing N+1 (stale)
     60s — the right floor for "intra-investigation hit, cross-investigation fresh"
```

The boundary: **the TTL is set by the agent's behavior pattern, not by data volatility**. The data (Bloomreach event counts) doesn't change that fast — a 5-minute TTL would still be technically "fresh." But the *agent's re-derive pattern* is what gives the cache leverage, and 60s is the window where that leverage is captured.

#### Move 2.3 — the error-bypass guard (the load-bearing correctness move)

After a miss, the code reaches the write decision. Here's where the most important line in the file lives:

```
  Pattern — the write path with error bypass

   # ... after the miss path runs ...

   if result is rate-limited:
     # retry loop runs (lib/mcp/client.ts:121-132)
     # after retries, either result is good OR result is still an error

   if (result as any)?.isError === true:                    ← THE GUARD
     return { result,                                       ← return the error envelope
              durationMs,                                    ← still report timing
              fromCache: false }                            ← but DO NOT STORE
                                                              IT IS THE LOAD-BEARING LINE
   # only on success:
   map.set(cacheKey, { result, expiresAt: now + ttl })
   return { result, durationMs, fromCache: false }
```

Without that guard, here's what happens on a rate-limit storm:

```
  Pattern — without the guard (the failure mode)

   t=0s:   call execute_analytics_eql({eql: "..."})
   t=0s:   spacing gate sleeps (no prior call)
   t=0s:   HTTPS to Bloomreach → 429 "rate limit reached (1 per 10 second)"
   t=10s:  retry → 429 again (some other process burning the quota)
   t=20s:  retry → 429 again
   t=30s:  retry → 429 again (3 retries spent, returns error envelope)

   ★ WITHOUT GUARD: cache stores the 429 error with expiresAt = now + 60s ★

   t=31s:  user reloads → same EQL → cache HIT returns the 429
   t=32s:  next agent re-derive → same EQL → cache HIT returns the 429
   ...
   t=90s:  cache finally expires (60s after t=30)

   for 60 seconds, every identical call returns the same stale error
   even though the actual rate limit cleared at t=10s.
   user is locked out by their own cache.
```

The guard turns this into:

```
  Pattern — with the guard (the correct behavior)

   t=0s:   call execute_analytics_eql({eql: "..."})
   t=0s:   429 → retry storm runs → final result is error envelope
   t=30s:  GUARD: not stored. Return the error to the caller.

   t=31s:  user reloads → same EQL → cache MISS (no entry)
   t=31s:  spacing gate sleeps (last call ended at t=30s)
   t=32s:  HTTPS to Bloomreach → 200 OK (rate limit cleared)
   t=32s:  GUARD passed, store. cache HIT for next 60s.

   no cache poisoning. user is back in business as soon as the rate
   limit clears, not 60s after.
```

The principle: **errors are transient; cached values pretend they're not**. Caching an error is implicitly claiming "this answer will be the same for the next 60 seconds" — which is the *opposite* of what an error means (rate limits clear; network blips resolve; servers come back). The guard is one line and it changes the cache from a perf optimization that occasionally hurts into a perf optimization that consistently helps.

---

### Move 3 — the principle

**Cache the wins, not the losses.** A cache's contract is "this answer is stable for N seconds." Errors break that contract — they're explicitly *un*stable (they exist because something transient went wrong). Caching an error pretends the brokenness is the new normal, and the user pays the cost until the TTL expires. The fix is one line in the write path: check `isError` before storing. blooming insights' cache does this; it's the difference between a cache that helps every time and a cache that helps most of the time and occasionally locks you out for a minute. The general lesson: **any cache write path needs to inspect what it's caching** — not just timestamp it and stash it.

---

## Primary diagram

The full picture — key derivation, read path, miss path, write path with the error guard.

```
  blooming insights — McpClient TTL cache, the full kernel

  ┌─ Input ──────────────────────────────────────────────────────────┐
  │  callTool(name, args, options)                                    │
  │  e.g. callTool('execute_analytics_eql', { project_id, eql })      │
  └────────────────────────┬──────────────────────────────────────────┘
                           │
  ┌─ KEY ──────────────────▼──────────────────────────────────────────┐
  │  cacheKey = `${name}:${JSON.stringify(args)}`                     │
  │  ★ EXACT MATCH — different arg ordering = different key ★          │
  │  ★ NO semantic similarity ★                                        │
  └────────────────────────┬──────────────────────────────────────────┘
                           │
                  ┌────────▼────────┐
                  │ skipCache?      │
                  └───┬─────────┬───┘
                     no        yes
                      │         │
  ┌─ READ ────────────▼─┐       │
  │  cached = map.get(key)│      │
  │  if cached AND        │      │
  │     expiresAt > now:  │      │
  │    ★ HIT (skip all)★  │      │
  │    return {result,    │      │
  │      durationMs: 0,   │      │
  │      fromCache: true} │      │
  └──────────┬────────────┘      │
             │ MISS               │
             ▼                    ▼
  ┌─ LIVE CALL (lib/mcp/client.ts:115-132) ───────────────────────────┐
  │  start = now                                                      │
  │  liveCall:                                                        │
  │    spacing gate (sleep up to 1100ms)                              │
  │    HTTPS POST to Bloomreach                                       │
  │  retry loop (if rate-limited, up to 3x with up to 20s wait each)  │
  │  durationMs = now - start                                         │
  └────────────────────────┬──────────────────────────────────────────┘
                           │
  ┌─ WRITE GUARD ──────────▼──────────────────────────────────────────┐
  │  if (result as any)?.isError === true:                            │
  │    ★ DO NOT STORE — return error envelope ★                        │
  │    return { result, durationMs, fromCache: false }                │
  │                                                                    │
  │  ★ only on SUCCESS: ★                                              │
  │  map.set(key, { result, expiresAt: now + 60_000 })                │
  │  return { result, durationMs, fromCache: false }                  │
  └────────────────────────────────────────────────────────────────────┘

  THE INVARIANT:
    map[key] only ever holds a successful result
    a rate-limit error never poisons the cache for 60s
```

---

## Implementation in codebase

### Use cases — where the cache hits and misses

- **Intra-investigation re-derive.** Claude exploring a hypothesis often re-runs the same EQL within seconds (e.g. "let me check conversion last 30 days... ok normal... let me re-run that for the prior period to compare"). Hit rate ~10-30% of calls in a typical diagnostic agent.
- **Bootstrap chain.** `bootstrapSchema` (`lib/mcp/schema.ts:170`) makes 4-6 MCP calls — none of them are cached at the McpClient level because the schema cache (a separate cache at `lib/mcp/schema.ts:131`) intercepts them at a higher layer.
- **Cross-investigation hit.** If two investigations within ~60s ask the same EQL question (e.g. two users investigating overlapping anomalies), the second pays 0ms for the shared calls.
- **Error scenarios where the guard matters.** Rate-limit retry storms on a busy Bloomreach day; transient network errors from the upstream MCP server; auth errors on cookie expiry mid-investigation.
- **`?skipCache=true` / `options.skipCache`** path — used by the `/debug/mcp` route for "force fresh" debugging.

### Code side by side

**The cache initialization and the cacheKey shape.**

```
  lib/mcp/client.ts  (lines 70–80, abbreviated)

  export class McpClient {
    private readonly cache: Map<string, CacheEntry> = new Map();    ← the cache itself
    private lastCallAt = 0;                                          ← spacing-gate state
    private readonly minIntervalMs: number;                          ← spacing budget
    private readonly maxRetries: number;
    private readonly retryDelayMs: number;
    private readonly retryCeilingMs: number;

    constructor(/* config */) { /* ... */ }

    async callTool<T = unknown>(name, args, options): Promise<CallToolResult<T>> {
      const cacheKey = `${name}:${JSON.stringify(args)}`;            ← KEY DERIVATION
        │
        └─ JSON.stringify gives stable byte representation for same-shape
           args. Two calls with different arg ORDERING produce different keys
           (e.g. {a:1,b:2} vs {b:2,a:1}) — this is the EXACT-MATCH choice (C3).
```

**The read path: hit short-circuits everything else.**

```
  lib/mcp/client.ts  (lines 102–110)

  const ttl = options.cacheTtlMs ?? 60_000;                          ← default 60s, overridable

  if (!options.skipCache) {                                          ← respect the debug override
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {                   ← FRESHNESS CHECK
      return {
        result: cached.result as T,
        durationMs: 0,                                                ← skip spacing AND network
        fromCache: true,                                              ← let the caller know
      };
    }
  }
        │
        └─ HIT path is 5 lines and exits the function. Misses fall through
           to the live call. The fromCache: true flag is propagated through
           ToolCall → tool_call_end event → UI status panel, which can
           render "cached" instead of a duration.
```

**The miss path: spacing + live call + retry.**

```
  lib/mcp/client.ts  (lines 115–132, abbreviated)

  const start = Date.now();                                          ← measure (Meter 1)
  let result = await this.liveCall(name, args);                      ← spacing + HTTPS

  let retries = 0;
  while (isRateLimited(result) && retries < this.maxRetries) {
    retries++;
    const hintMs = parseRetryAfterMs(result);
    const backoffMs = this.retryDelayMs * 2 ** (retries - 1);
    const waitMs = Math.min(
      hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,
      this.retryCeilingMs,
    );
    await sleep(waitMs);                                             ← retry wait
    result = await this.liveCall(name, args);                        ← retry
  }
  const durationMs = Date.now() - start;
        │
        └─ if the retry loop exhausts maxRetries, result is still the error
           envelope. The write-guard (next snippet) handles that case.
```

**The write path with the error-bypass guard — the load-bearing correctness line.**

```
  lib/mcp/client.ts  (lines 137–145)

  if ((result as any)?.isError === true) {                           ← THE GUARD
    return {
      result,                                                         ← propagate the error
      durationMs,                                                     ← still report timing
      fromCache: false,                                               ← NOT cached
    };
  }                                                                   ← exit WITHOUT storing

  const now = Date.now();
  this.cache.set(cacheKey, { result, expiresAt: now + ttl });        ← STORE on success only
  return { result, durationMs, fromCache: false };
        │
        └─ THE invariant: map[cacheKey] only holds successful results.
           A rate-limit error returned by the retry-exhausted loop is
           propagated to the caller but NEVER stored. The next call with
           the same args sees a cache miss and tries again immediately
           (after spacing) — not 60s from now.
```

**The cache hit's visible effect: durationMs: 0, fromCache: true on the event stream.**

```
  lib/agents/base.ts  (line 150-ish; the per-tool-call dispatch)

  const { result, durationMs, fromCache } = await this.mcp.callTool(
    toolUse.name,
    toolUse.input,
  );
  // ... (toolCalls.push, hook.toolCallEnd, etc.) ...

  // emitted on the NDJSON stream as tool_call_end with durationMs + fromCache
  // UI status panel (StatusLog) shows the value
        │
        └─ a cached call shows up as "cached" in the UI, not "0ms" —
           which is a deliberate UX choice. The fromCache flag also lets
           any aggregation distinguish "we paid 0ms because cache" from
           "we paid 0ms because the call was free (it shouldn't be).
```

---

## Elaborate

**Where this pattern comes from.** TTL-bounded result caching is one of the oldest patterns in distributed systems — Varnish, memcached, Redis with `EXPIRE`, browser HTTP cache with `Cache-Control: max-age`. The error-bypass guard is sometimes called "negative-cache avoidance" or "don't cache failures" — it's named less often than the cache itself, but it shows up in mature codebases when someone has been bitten by the failure mode. RFC 7234 (HTTP caching) explicitly notes that error responses are cacheable *only if* they have explicit cache directives — the default is to *not* cache them. blooming insights' guard is the same idea applied at the application layer.

**Why exact-match keying (and not semantic-similar). C3 in the structure pass.** The cacheKey uses `JSON.stringify(args)` which is byte-exact. Semantic similarity would let you say "this EQL with `filter=A` is similar enough to that EQL with `filter=A,B` to return the same result" — but that's *almost always wrong* for analytics queries. The right answer for a different filter is a different number, even if the queries look similar. Exact-match accepts more cache misses in exchange for *bounded staleness*: if the same call repeats with the same args within 60s, the user expects the same number; that's safe. A semantic-similar cache would silently return wrong answers — a far worse failure mode than a missed cache hit. Cross-link: `study-agent-architecture/05-production-serving/01-cross-turn-caching.md` walks the three cache scopes (intra-turn, intra-run, cross-run) and why semantic similarity is deliberately off the table for this codebase.

**Why 60 seconds specifically.** The TTL needs to be longer than the *intra-agent* re-derive window (~30-50s for a typical diagnostic agent) and shorter than the *cross-briefing* refresh interval (~few minutes). 60s lands in the gap. Shorter TTLs (10s) would miss intra-agent hits and lose the leverage; longer TTLs (300s) would carry briefing N's results into briefing N+1, returning stale data on the second briefing of a session. The TTL is set by the agent's behavior pattern, not by data volatility — which is unusual. The right framing isn't "how often does Bloomreach's data change?" (answer: minutes); it's "how often does Claude ask the same question twice?" (answer: within seconds, on the same investigation).

**Connection to adjacent concepts.** This cache is one of three at this layer (the schema cache at `lib/mcp/schema.ts:131` and the investigation-replay store at `lib/state/investigations.ts:11` are the other two — see `audit.md#caching-batching-and-backpressure`). `03-spacing-gate-as-rate-limit-compliance.md` covers the rate-limit floor that this cache lets you skip. `study-agent-architecture/05-production-serving/01-cross-turn-caching.md` walks the LLM-side caching scopes that this codebase deliberately doesn't use. `study-ai-engineering/06-production-serving/01-llm-caching.md` covers Anthropic's prompt-prefix caching — a related-but-different cache at a different layer.

---

## Interview defense

### Q: Walk me through the McpClient cache. Why does it exist, what's the TTL, and what's the most important line?

**Answer:** It's a `Map<string, { result, expiresAt }>` at `lib/mcp/client.ts:80` keyed on `${name}:${JSON.stringify(args)}`. The TTL defaults to 60 seconds. On a hit, the cache returns `{ durationMs: 0, fromCache: true }` — skipping the 1.1s spacing gate AND the network round-trip entirely. The most important line is at `lib/mcp/client.ts:137-145`: if the result is an error envelope (`(result as any)?.isError === true`), the code returns *without* storing. That's the negative-cache avoidance guard — without it, a rate-limit error would poison the cache for 60s and lock the user out long after the actual rate limit cleared. One line, load-bearing.

```
  the cache, three parts ranked by importance

   1. error-bypass guard — without it, the cache hurts (lock-out)
   2. exact-match keying — semantic similarity would return wrong answers
   3. 60s TTL           — tuned to Claude's re-derive window, not data volatility
```

### Q: Why is 60 seconds the right TTL, not 10 or 300?

**Answer:** It's tuned to the *agent's re-derive pattern*, not to data volatility. Claude exploring a hypothesis often re-runs the same EQL within seconds — for example, "let me check conversion last 30 days... let me re-check the prior 30 days for comparison... let me re-derive the first one to confirm." Hit rate within a 30-50s diagnostic agent: ~10-30% of calls. The TTL needs to be longer than the typical investigation phase (~30-50s) to catch those re-derives. It also needs to be shorter than the typical re-briefing cadence (a few minutes) so a new briefing sees fresh data. 60s lands in that gap. 10s would miss the intra-agent re-derives (losing the leverage); 300s would carry briefing N's results into briefing N+1 (stale data).

### Q: A teammate says "why not cache the rate-limit errors too — at least we'd skip the spacing gate next time." Defend the current design.

**Answer:** Caching the error fundamentally changes its meaning. An error means "this thing didn't work *just now*"; caching it claims "this thing will not work for the next 60 seconds." Those aren't the same statement. A rate-limit error clears as soon as the window resets — which might be 1 second from now. Caching it means every identical call for the next 60 seconds returns the same stale error, even after the rate limit cleared. The user is locked out by their own cache. The current design — don't cache errors, let the next call try again immediately (subject to the spacing gate) — is correct because the spacing gate is exactly 1.1s, which is the *right* throttling for "the rate limit might have just cleared, let's check." Caching the error skips that 1.1s wait, but in exchange for being wrong for 60s. The trade is asymmetric: the worst case of the current design is 1.1s of delayed retry; the worst case of the proposed design is 60s of unjustified failure.

---

---

## See also

- `audit.md` — the lens-level findings, including this cache in `caching-batching-and-backpressure`
- `01-300s-vercel-budget-as-hard-ceiling.md` — the budget this cache helps fit under
- `03-spacing-gate-as-rate-limit-compliance.md` — the floor this cache lets you skip on a hit
- `04-synthesize-as-cost-concentration.md` — the unmeasured cost line that no cache helps with
- `.aipe/study-agent-architecture/05-production-serving/01-cross-turn-caching.md` — the three cache scopes and why semantic similarity is off the table
- `.aipe/study-ai-engineering/06-production-serving/01-llm-caching.md` — Anthropic's prompt-prefix caching (a related-but-different cache at a different layer)

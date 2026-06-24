# Timeouts, retries, pooling, and backpressure

**Industry name(s):** rate-limit budget, retry-with-jitter, exponential backoff, connection pooling, in-process request caching, backpressure
**Type:** Industry standard · Language-agnostic

> The load-bearing pattern in this entire repo. Bloomreach enforces ~1 req / 10 s per user globally; the whole `McpClient` is built around honoring it without burning the 300 s route budget. Pooling and explicit timeouts are `not yet exercised` — the absence is honest, and naming it is part of the audit.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Three mechanisms in the codebase manage upstream load: **proactive spacing** (don't issue a call within 1.1 s of the last one), **retry on rate-limit** (parse the 429 hint, wait that long + 500 ms buffer, up to 20 s ceiling, up to 3 times), and **in-process response cache** (60 s TTL on identical calls, in a per-instance Map). Together they turn Bloomreach's harsh 1-per-10-s window into a workable budget for a 60–115 s investigation. *Pooling, per-call timeouts, and backpressure are absent*; the absence is part of the picture and named honestly here.

```
Zoom out — the three load-management mechanisms

┌─ Browser ──────────────────────────────────────────────────────────┐
│  ★ no app-layer rate limit ★ — user can click freely               │
└────────────────────────┬───────────────────────────────────────────┘
                         │  one click = one fetch = one route run
                         ▼
┌─ Serverless function (route handler) ──────────────────────────────┐
│  maxDuration = 300s — the hard ceiling for every budget below      │
└────────────────────────┬───────────────────────────────────────────┘
                         │
                         ▼
┌─ McpClient (lib/mcp/client.ts) ────────────────────────────────────┐
│  mechanism 1: in-process cache (60s TTL, per Map)                  │
│     → if hit, no upstream call at all                              │
│  mechanism 2: proactive spacing (≥ 1100ms since last call)         │
│     → sleep if needed BEFORE issuing fetch                         │
│  mechanism 3: rate-limit retry (parse hint, backoff, cap, max 3)   │
│     → fires AFTER call returns isError:true with rate-limit text   │
└────────────────────────┬───────────────────────────────────────────┘
                         │
                         ▼
┌─ Bloomreach Loomi MCP ────┐    ┌─ Anthropic API ────────────────────┐
│  rate-limited: 1/10s     │    │  ★ no rate-limit handling in repo ★│
│  per-user, GLOBAL        │    │  default sdk pool, no timeout       │
└──────────────────────────┘    └────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this file answers: how does this app stay alive against a 1-req-per-10-s upstream when each investigation needs ~6 calls? The answer is the three-mechanism stack above, with one load-bearing surprise — Bloomreach signals rate-limit via HTTP 200 + an `isError: true` envelope, *not* via HTTP 429, so the client parses *text* in the response body to detect it.

---

## Structure pass

**Layers.** Four layers where load management lives. **Route** (Vercel's `maxDuration = 300` — the hard ceiling that constrains every other budget). **Client** (`McpClient` — spacing + retry + cache, all in-process). **Transport** (undici's keep-alive pool — unconfigured). **Upstream** (Bloomreach's rate limit + Anthropic's lack of one).

**Axis: failure.** Trace "where does the request fail, and what catches it?" across the layers. **Route layer:** failure = hung function, caught by Vercel killing the process at 300 s — visible to the user as silent end-of-stream. **Client layer:** failure = rate-limit returned by Bloomreach, caught by `isRateLimited(result)` parsing the text, retried up to 3 times. **Transport layer:** failure = connection error / 5xx, NOT specifically handled — bubbles up as `McpToolError`. **Upstream:** failure originates here.

**Seams.** Three seams matter, two load-bearing.

  → **Seam 1 (load-bearing): the rate-limit envelope.** Failure-shape flips from "HTTP 429 (standard, library can sniff)" to "HTTP 200 + `isError: true` + text payload (must be parsed)." Bloomreach is non-standard here, and the parser is the contract.
  → **Seam 2 (load-bearing): the retry ceiling vs route budget.** `maxRetries: 3` × `retryCeilingMs: 20_000` = up to 60 s on a single tool call. Against a 300 s route budget that's 20%; against a 6-call investigation that means even one rate-limited call eats meaningful time.
  → **Seam 3: cache hit vs miss.** Failure flips from "spends rate-limit budget" to "free." The 60-second TTL is the assumption — calls identical inside 60 s are safe to return cached.

```
Three load-management seams

  seam                              flip                        load-bearing?
  ────                              ────                        ─────────────
  rate-limit envelope               429-standard → 200+text     yes (correctness)
  retry ceiling vs route budget     20% of budget per stuck call yes (liveness)
  cache hit vs miss                 paid → free                 yes (cost)
```

The skeleton is mapped — the rest walks the mechanism.

---

## How it works

### Mental model

Think of it as three concentric defenses, evaluated in order on each `callTool`: cache first (free), spacing second (cheap delay), retry last (expensive but correct). The first one that resolves the call wins.

```
The shape — three concentric defenses

  callTool(name, args)
       │
       ▼
   ┌───────────────────────┐
   │ 1. CACHE: hit?         │  ──► yes → return cached
   └────────┬──────────────┘                  (free, durationMs:0)
            │ miss
            ▼
   ┌───────────────────────┐
   │ 2. SPACING: ≥1.1s     │  ──► not yet → sleep(delta)
   │    since last call?    │
   └────────┬──────────────┘
            │ ok now
            ▼
   ┌───────────────────────┐
   │ 3. CALL upstream      │
   └────────┬──────────────┘
            │
            ▼
   ┌───────────────────────┐
   │ 4. RATE-LIMITED?       │  ──► no → cache + return
   │    parse isError +     │
   │    rate-limit text     │
   └────────┬──────────────┘
            │ yes
            ▼
   ┌───────────────────────┐
   │ 5. RETRY (max 3):      │
   │    parse wait hint,    │  ──► loop back to 3
   │    sleep min(hint,20s),│
   └───────────────────────┘
```

### Move 2 walkthrough

**Mechanism 1: the in-process Map cache.** Every `callTool(name, args)` computes a cache key `"${name}:${JSON.stringify(args)}"`. If a non-expired entry exists, return it. The TTL defaults to 60 s; callers can override per-call (`{ cacheTtlMs: 5_000 }` for fast-changing data) or skip entirely (`{ skipCache: true }` for the `/debug` route). Error results are NOT cached — an `isError` response bypasses the `cache.set` so we don't poison the cache with a transient rate-limit.

```
Pseudocode — cache logic

  function callTool(name, args, options):
    cacheKey = name + ':' + json(args)
    ttl = options.cacheTtlMs or 60_000
    
    if not options.skipCache:
      cached = cache.get(cacheKey)
      if cached and cached.expiresAt > now():
        return {result: cached.result, durationMs: 0, fromCache: true}
                                       │
                                       └─ durationMs:0 is the signal
                                          to the caller that this was
                                          a cache hit (used for logging)
    
    result = await liveCall_with_retry(name, args)
    
    if result.isError:
      return result                    // ← NOT cached; transient errors
                                          must not poison the cache
    
    cache.set(cacheKey, {result, expiresAt: now() + ttl})
    return result
```

The boundary that catches people: the cache is per Map, per function instance. Vercel cold starts get an empty cache; warm starts share it across requests on the same instance. There is no cross-instance cache (no Redis, no Vercel KV). Two concurrent users with overlapping calls don't share cache hits.

**Mechanism 2: proactive spacing.** Before issuing any live call, check `Date.now() - lastCallAt`. If less than `minIntervalMs` (default 1100), sleep the difference. This is the "be a polite neighbor" mechanism — never send two calls within 1.1 s, even if Bloomreach's window is 10 s. Why 1.1 s and not 10 s? Because at 10 s spacing, six investigation calls would be 60 s of *just spacing*, blowing the route budget. 1.1 s lets the calls go through as fast as Bloomreach's looser interpretation allows, and the retry mechanism handles the cases where the strict 10-s window kicks in.

```
Pseudocode — spacing

  function liveCall(name, args):
    elapsed = now() - lastCallAt
    if elapsed < minIntervalMs:               // ← default 1100ms
      sleep(minIntervalMs - elapsed)
    try:
      result = await transport.callTool(name, args)
      lastCallAt = now()                       // ← set on success
      return result
    catch err:
      lastCallAt = now()                       // ← set on failure too,
                                                //   so we don't re-burst
                                                //   after an error
      throw new McpToolError(name, errorDetail(err))
```

**Mechanism 3: rate-limit retry.** After `liveCall` returns, check if the result is the rate-limit envelope. Two shapes seen in the wild — `"Retry after ~12 second(s)"` and `"rate limit reached (1 per 10 second)"` — both get parsed. If a hint is present, wait `hint + 500 ms` (the buffer lands the retry *just after* the window clears, not on its boundary). If no hint, exponential backoff: `retryDelayMs × 2^retries`. Either wait is capped at `retryCeilingMs` (default 20 s). Max 3 retries.

```
Pseudocode — retry loop

  result = await liveCall(name, args)
  retries = 0
  
  while isRateLimited(result) and retries < maxRetries:
    retries += 1
    
    hintMs = parseRetryAfterMs(result)         // try to read the wait
                                                //   from the response text
    
    backoffMs = retryDelayMs * 2 ** (retries-1) // fallback: exponential
                                                //   from base (default 10s)
    
    waitMs = min(
      hintMs + 500ms if hintMs else backoffMs,
      retryCeilingMs                           // hard ceiling: 20s
    )
    
    sleep(waitMs)
    result = await liveCall(name, args)
  
  return result
```

Three load-bearing pieces inside this loop:

  → **The text parser.** Bloomreach signals rate-limit via the response body, not HTTP 429. `isRateLimited` does `JSON.stringify(content) → /rate limit|too many requests/i.test`. If Bloomreach changes the wording, this silently breaks.
  → **The `+ 500 ms` buffer.** Without it, a retry timed to exactly the window-edge can land on the boundary and get rate-limited again (the upstream's clock isn't ours).
  → **The ceiling.** Without `retryCeilingMs: 20_000`, a parsed hint of "retry after 120 seconds" would sleep for 2 minutes — eating ~40% of the route budget on a single call. The ceiling forces a give-up that surfaces the error to the user instead.

**Mechanism 4 (absent): per-call timeout.** There is no `AbortController`+`signal` on any upstream fetch. A truly hung Bloomreach socket consumes the route's full 300 s. Vercel kills the function; user sees silent end of stream. This is `not yet exercised` and is `red flag #1` in `08-networking-red-flags-audit.md`.

**Mechanism 5 (absent): connection pool configuration.** No `Dispatcher`, no `Agent({ connections, keepAliveMsecs })`. Undici defaults: ~10 connections per origin, ~5 s keep-alive. For ~6 Bloomreach calls per investigation, the cost of NOT pooling is single-digit-ms-per-call. `not yet exercised`.

**Mechanism 6 (absent): backpressure / queueing.** If two requests land on the same warm function instance simultaneously, they both share `lastCallAt` — meaning they may interleave and break the spacing. There's no per-instance request queue, no semaphore. With one user at a time this never triggers. `not yet exercised`.

### Skeleton — the load-bearing kernel

The pattern reduces to: **spacing-gated request + result-shape-aware retry + TTL'd response cache**. Each part has a clear failure mode if removed:

```
The kernel — what breaks if each part is missing

  ┌───────────────────────────────────────────────────────────────────┐
  │ PART                       BREAKS IF MISSING                       │
  ├───────────────────────────────────────────────────────────────────┤
  │ proactive spacing           bursts of calls trigger rate limit on  │
  │  (minIntervalMs)            EVERY call, not just contested ones    │
  │                                                                    │
  │ rate-limit detection        retry never fires; rate-limit error    │
  │  (parse text, not 429)      bubbles to user with no recovery       │
  │                                                                    │
  │ retry with hint+buffer      retries land on window boundary and    │
  │  (parsedHint + 500ms)       get rate-limited again immediately     │
  │                                                                    │
  │ retry ceiling                a stale hint ("retry after 120s") eats │
  │  (retryCeilingMs)           40% of route budget on one call         │
  │                                                                    │
  │ response cache               every repeat call burns rate-limit     │
  │  (60s TTL Map)              budget even for identical args         │
  │                                                                    │
  │ skip-cache on isError        a transient rate-limit becomes a 60s  │
  │  (don't cache errors)       outage cached as "ground truth"        │
  └───────────────────────────────────────────────────────────────────┘
```

Optional hardening on top of the kernel: a per-call `AbortSignal.timeout(15_000)`; a cross-instance cache (Vercel KV); an exponential-jitter mode for the backoff. None are in the repo.

### Principle

Honor the upstream's *stated* limits, don't infer them. When the upstream tells you the wait window in its error body, parse it and use it — fixed backoff is a hack for the case where the upstream doesn't tell you. Always add a buffer (so retry lands *after* the window, not on its edge), always add a ceiling (so a misbehaving upstream can't burn your whole budget), and always be ready for the upstream to change its error wording (so the parser is a single function you can update in one place).

---

## Primary diagram

The recap — every load-management mechanism in one frame.

```
Load management — full recap

UI band ──────────────────────────────────────────────────────────
┌────────────────────────────────────────────────────────────────┐
│  fetch(...)                                                     │
│  no app-layer rate limit; user can click freely                │
│  cancellation: deliberately NOT on effect cleanup (StrictMode)  │
└─────────────────────────┬──────────────────────────────────────┘
                          │
Route band ───────────────▼──────────────────────────────────────
┌────────────────────────────────────────────────────────────────┐
│  maxDuration = 300s — the hard ceiling                          │
│  NO per-call AbortController (★ red flag #1 ★)                  │
└─────────────────────────┬──────────────────────────────────────┘
                          │
Client band ──────────────▼──────────────────────────────────────
┌────────────────────────────────────────────────────────────────┐
│  McpClient.callTool                                             │
│    1. cache.get(key) → hit returns instantly (60s TTL)          │
│    2. sleep(1.1s - elapsed) — proactive spacing                 │
│    3. transport.callTool — actual upstream POST                 │
│    4. isRateLimited(result) → parse text, not HTTP status       │
│    5. retry loop:                                               │
│         hint = parseRetryAfterMs(result)                        │
│         wait = min(hint + 500ms OR backoff * 2^retry, 20s)      │
│         sleep(wait); call again                                 │
│         max 3 retries                                           │
│    6. cache.set on success only (skip on isError)               │
└─────────────────────────┬──────────────────────────────────────┘
                          │
Transport band ───────────▼──────────────────────────────────────
┌────────────────────────────────────────────────────────────────┐
│  undici default agent (no Dispatcher, no Agent({...}))          │
│  no per-call timeout                                            │
│  no backpressure, no queue                                      │
│  no pool configuration                                          │
└─────────────────────────┬──────────────────────────────────────┘
                          │
Upstream band ────────────▼──────────────────────────────────────
┌─────────────────────────────────────┐  ┌──────────────────────┐
│  Bloomreach: 1/10s, per-user GLOBAL │  │  Anthropic: no limit │
│  signals via 200 + isError envelope │  │  handling in repo    │
│  retry hint in body text            │  │                      │
└─────────────────────────────────────┘  └──────────────────────┘
```

---

## Implementation in codebase

### Use cases

  → **Briefing scan with rate-limit hit at category 4.** Spacing keeps calls 1.1 s apart; at category 4, Bloomreach returns the 200 + `isError` envelope; client parses "retry after 10 seconds", waits 10.5 s, retries; category 4 succeeds; categories 5–10 proceed.
  → **Diagnostic agent with cache hit on the second tool call.** Agent decides to re-read the same EQL it already ran; cache returns instantly (`durationMs:0`); no upstream hop, no rate-limit budget spent.
  → **Capture-all (`captureAll` on `/`).** Sequential investigations, intentionally one-at-a-time to honor the ~1 req/s window across the whole capture (`runInvestigation` blocks the next one).

### Cache + spacing + retry, in one file

```
lib/mcp/client.ts  (lines 97-146, the orchestration)

async callTool<T = unknown>(
  name: string,
  args: Record<string, unknown>,
  options: CallToolOptions = {},
): Promise<CallToolResult<T>> {
  const cacheKey = `${name}:${JSON.stringify(args)}`;
                                          │
                                          └─ JSON.stringify(args) is the
                                             cache key — relies on stable
                                             key order. For args with deep
                                             objects, two equivalent shapes
                                             with different key orders would
                                             miss cache (rare but real).
  const ttl = options.cacheTtlMs ?? 60_000;

  if (!options.skipCache) {
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { result: cached.result as T, durationMs: 0, fromCache: true };
                                          │
                                          └─ instantly return; no upstream
                                             hop, no rate-limit spend.
    }
  }

  const start = Date.now();
  let result = await this.liveCall(name, args);
                                          │
                                          └─ liveCall handles spacing + the
                                             actual fetch; throws McpToolError
                                             on transport failures.

  // Rate-limit retry. Bloomreach enforces a multi-second global window…
  let retries = 0;
  while (isRateLimited(result) && retries < this.maxRetries) {
    retries++;
    const hintMs = parseRetryAfterMs(result);
                                          │
                                          └─ try to read "retry after Ns" or
                                             "per Ns" from the response text.
                                             Returns null if unparseable.
    const backoffMs = this.retryDelayMs * 2 ** (retries - 1);
                                          │
                                          └─ fallback: 10s, 20s, 40s. Hits
                                             the ceiling at retry 2.
    const waitMs = Math.min(
      hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,
                       │
                       └─ +500ms lands the retry JUST AFTER the window
                          clears, not ON its boundary (load-bearing).
      this.retryCeilingMs,
                       │
                       └─ 20s ceiling: a stale hint of 120s would otherwise
                          eat 40% of the 300s route budget on ONE call.
    );
    await sleep(waitMs);
    result = await this.liveCall(name, args);
  }

  const durationMs = Date.now() - start;

  if ((result as any)?.isError === true) {
    return { result: result as T, durationMs, fromCache: false };
                                          │
                                          └─ DON'T cache errors. A transient
                                             rate-limit cached as ground truth
                                             would be a 60s outage for repeats.
  }

  const now = Date.now();
  this.cache.set(cacheKey, { result, expiresAt: now + ttl });
  return { result: result as T, durationMs, fromCache: false };
}
```

### The spacing gate

```
lib/mcp/client.ts  (lines 148-163)

private async liveCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
                                          │
                                          └─ in-process sleep BEFORE the
                                             outbound fetch. Honors Bloom-
                                             reach's looser interpretation
                                             of its own window (~1s) without
                                             paying the strict 10s on every
                                             call.
  }
  try {
    const result = await this.transport.callTool(name, args);
    this.lastCallAt = Date.now();
                                          │
                                          └─ stamp AFTER the call returns,
                                             not before — otherwise a slow
                                             call's spacing-debt is wrong.
    return result;
  } catch (err) {
    this.lastCallAt = Date.now();
                                          │
                                          └─ stamp on failure TOO, so we
                                             don't immediately burst-retry
                                             into a still-broken upstream.
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}
```

### The rate-limit detection and hint parser

```
lib/mcp/client.ts  (lines 18-38)

function isRateLimited(result: unknown): boolean {
  if (!result || typeof result !== 'object' || (result as any).isError !== true) return false;
  const text = JSON.stringify((result as any).content ?? result);
  return /rate limit|too many requests/i.test(text);
                                          │
                                          └─ text-match the rate-limit
                                             envelope. If Bloomreach
                                             changes wording, this silently
                                             breaks (the call returns
                                             isError to the caller without
                                             retrying). Known fragility.
}

function parseRetryAfterMs(result: unknown): number | null {
  const text = JSON.stringify((result as any)?.content ?? result);
  const after = text.match(/retry[\s-]*after[^0-9]*(\d+)\s*second/i);
                                          │
                                          └─ shape 1: "Retry after ~12 second(s)"
  if (after) return parseInt(after[1], 10) * 1000;
  const perWindow = text.match(/per\s*(\d+)\s*second/i);
                                          │
                                          └─ shape 2: "rate limit reached
                                             (1 per 10 second)"
  if (perWindow) return parseInt(perWindow[1], 10) * 1000;
  return null;
                                          │
                                          └─ no hint → caller falls back
                                             to exponential backoff.
}
```

### The instantiation — where the budget is set

```
lib/mcp/connect.ts  (lines 89-97)

return {
  ok: true,
  mcp: new McpClient(new SdkTransport(client, httpErrors), {
    minIntervalMs: 1100,
                                          │
                                          └─ proactive spacing. 1.1s, not
                                             10s, because 10s spacing × 6
                                             calls = 60s of pure spacing,
                                             blowing the budget.
    retryDelayMs: 10_000,
                                          │
                                          └─ fallback when no hint parsed.
                                             Matches the observed 10s
                                             window.
    retryCeilingMs: 20_000,
                                          │
                                          └─ hard ceiling on ANY wait.
                                             Stale hint of 120s → still
                                             only 20s wait.
    maxRetries: 3,
                                          │
                                          └─ 3 retries × 20s ceiling = up
                                             to 60s on a single tool call.
                                             20% of route budget; the cost
                                             of correctness.
  }),
};
```

### What's absent (and the verdict)

  → **Per-call timeout: asymmetric coverage (Phase 2, 2026-06-15).** The `DataSource` interface now accepts an optional `AbortSignal` (`callTool(name, args, opts?: { signal? })`). **Olist side**: `lib/data-source/olist-data-source.ts:151` composes the caller signal with `AbortSignal.timeout(30_000)` — every call has a 30s timeout. **Bloomreach side**: the Bloomreach adapter (`lib/data-source/bloomreach-data-source.ts`, formerly `lib/mcp/client.ts`) still has NO per-call timeout — only the 300s route ceiling above. Closing the asymmetry is a ~10-line mirror of the Olist pattern; the cheapest production-grade networking fix in the codebase. Insertion point is the Bloomreach adapter's `callTool` (mirroring the Olist `composeSignals` helper).
  → **No connection pool config.** Grep for `Dispatcher`, `Agent(`, `pool`, `keepAliveMsecs` returns no app hits. Verdict: `not yet exercised`.
  → **No backpressure / queue.** Grep for `Semaphore`, `pLimit`, `queue` returns no app hits. The single in-process Map cache + spacing gate are the only shared-resource discipline. Verdict: `not yet exercised`; would matter if two users hit the same warm instance.

---

## Elaborate

The "retry hint in response body, not HTTP 429" pattern is unusual but not unique — some MCP servers do this because the MCP spec is JSON-RPC-shaped (errors live in the envelope), and "200 with an error envelope" is the JSON-RPC native way. The cost is that generic HTTP middleware (load balancers, generic retry libraries) can't help you — they look at status codes, not body text. We pay this cost in `lib/mcp/client.ts`'s text-matching.

Exponential backoff with jitter is the textbook pattern; we use exponential *without* jitter (because we're a single user, not a thundering herd). If we ever had multiple concurrent users sharing a function instance, jitter would matter (otherwise their retries would synchronise on the same window-edge and dogpile).

The 60-second response cache TTL is a "good enough" pick. For schema reads (which change infrequently), it's actually conservative; for fresh analytics queries (where the answer changes minute-to-minute), it might be too long. The callers can override per-call (`{ cacheTtlMs: 5_000 }`) but the default is the right shape for typical use.

Anthropic gets no rate-limit handling in this repo because the LLM provider's rate limits are very high relative to our usage (one user, low calls/min). If we ever turned this into a high-traffic product, we'd need equivalent retry logic there — `@anthropic-ai/sdk` exposes a `maxRetries` option we don't currently configure.

---

## Interview defense

**Q1: Walk me through your rate-limit handling.**

Three concentric mechanisms. Inner: 60-second in-process Map cache on `name + args` — identical calls inside a minute don't hit upstream. Middle: proactive spacing of 1.1 s between any two upstream calls. Outer: on the rate-limit envelope (`200 + isError + text matching /rate limit/`), parse the wait hint, sleep `hint + 500 ms` (or exponential fallback), capped at 20 s, max 3 retries. The whole stack runs inside a 300 s route budget.

```
Diagram-while-you-speak

  cache (free) → spacing (1.1s) → call → parse rate-limit body
                                            │
                                            └─ if hit: sleep(hint+500ms) → retry (max 3)
```

Anchor: "the surprise is that Bloomreach signals rate-limit via response body text, not HTTP 429 — so we parse text."

**Q2: Why 1.1 s spacing and not the full 10-s window?**

Math. Six calls × 10 s spacing = 60 s of pure spacing, on top of the actual call latency. Against a 300 s route budget that's 20% of the budget burned to do nothing. Bloomreach's looser interpretation lets calls go through faster in practice; the strict 10-s window kicks in occasionally and the retry mechanism handles it. Net: faster typical case, slower worst case, same correctness.

**Q3: What's the biggest gap in this stack today?**

No per-call `AbortController`. If a Bloomreach socket hangs at minute 2, we eat the rest of the route budget — Vercel kills the function at 300 s and the user sees silent end of stream. The fix is wrapping `init.signal` with `AbortSignal.timeout(15_000)` in `makeCapturingFetch`. It's a 5-line patch; it's not in the repo because we haven't observed the failure mode yet. Honest gap.

---

---

## See also

  → `01-network-map.md` — where this client sits in the system.
  → `03-tcp-udp-connections-and-sockets.md` — the (absent) connection pool layer below this.
  → `08-networking-red-flags-audit.md` — the audit ranks the missing per-call timeout as risk #1.

---
Updated: 2026-06-16 — per-call timeout finding flipped from "not yet exercised" to "asymmetric coverage" — Olist side closed (30s AbortSignal.timeout at olist-data-source.ts:151), Bloomreach side still open. ~10-line mirror is the cheapest production-grade fix.

---
Updated: 2026-06-19 — The asymmetric per-call timeout finding (Olist 30s vs Bloomreach none) collapses: Olist side deleted in PR #8. Bloomreach still has no per-call timeout — that finding stands. SyntheticDataSource is in-process so timeout discipline doesn't apply.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).

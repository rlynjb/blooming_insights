# 04 — rate limiting and backpressure

**Subtitle:** Provider-side rate limit + retry · Industry standard (load-bearing)

## Zoom out, then zoom in

**Load-bearing for live mode.** The Bloomreach alpha MCP server enforces
"1 per 10 seconds" globally per user. Without explicit rate-limit
handling, the live mode hits 429 (or its MCP equivalent) on the second
tool call. `BloomreachDataSource` parses the server's stated penalty
window, sleeps, and retries up to 3 times — this is what makes
multi-tool-call agent loops work at all.

```
  Zoom out — rate-limit handling sits at the data-source layer

  ┌─ AptKit agent loop ────────────────────────────────┐
  │  model picks tool_use → BloomingToolRegistryAdapter│
  │                          .callTool()               │
  └──────────────────────┬─────────────────────────────┘
                         │
                         ▼
  ┌─ BloomreachDataSource.callTool ────────────────────┐
  │  ★ rate-limit retry ladder ★                        │  ← we are here
  │  - detect rate limit (isError + text match)         │
  │  - parse Retry-After hint                           │
  │  - sleep parsed_hint OR exponential backoff         │
  │  - retry up to maxRetries (3)                       │
  │  - cap each wait at retryCeilingMs (20s)            │
  └──────────────────────┬─────────────────────────────┘
                         │
                         ▼
  ┌─ MCP transport → Bloomreach loomi connect ──────────┐
  │  server returns rate-limit error envelope            │
  └──────────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — retry strategy.** Parse the server's stated
    wait (preferred) → exponential backoff (fallback) → cap at
    ceiling. Each decision optimizes for "land just AFTER the
    penalty clears, not before, not way after."

## How it works

### Move 1 — the mental model

Same shape as a typed-rate-limit-aware HTTP client (axios with
retry-after support, Cloudflare's auto-retry). The provider tells you
when to come back; honor it.

```
  Retry ladder

  call tool → ok? → return
       │ no, rate limit
       ▼
  parse Retry-After from error envelope
       │
  ┌────┴────┐
  │         │
  ▼ found   ▼ not found
   sleep    exponential backoff
   (hint+   (retryDelayMs *
    buffer) 2^retry_count)
       │         │
       ▼         ▼
       cap at retryCeilingMs
       │
       ▼
  retry call
       │
   retry count < maxRetries?
   ┌──┴──┐
   │     │
   ▼ yes ▼ no
   loop  return error result
```

### Move 2 — the step-by-step walkthrough

**Detection — `isRateLimited`** (`lib/data-source/bloomreach-data-source.ts:51-55`):

```typescript
function isRateLimited(result: unknown): boolean {
  if (!result || typeof result !== 'object' || (result as any).isError !== true) return false;
  const text = JSON.stringify((result as any).content ?? result);
  return /rate limit|too many requests/i.test(text);
}
```

The MCP server returns rate limits as error results (not HTTP 429 —
the tool-call wrapper hides the transport). `isError: true` plus text
matching "rate limit" or "too many requests" is the detection.

**Parsing the wait hint — `parseRetryAfterMs`**
(`lib/data-source/bloomreach-data-source.ts:64-71`):

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

Two regex patterns matching the two observed shapes:
  - `"Retry after ~12 second(s)"` → 12000
  - `"rate limit reached (1 per 10 second)"` → 10000

Returns null when neither matches; the caller falls back to backoff.

**The retry loop — `callTool`**
(`lib/data-source/bloomreach-data-source.ts:163-174`):

```typescript
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

The breakdown:

  → **`retryDelayMs = 10_000`** (default, line 135). The comment says:
    *"Bloomreach's observed penalty window is ~10s ('1 per 10 second'),
    so a fixed sub-second retry just burns the attempt inside the same
    window. Default the fallback base to that window."*

  → **`RETRY_BUFFER_MS = 500`** (line 49). Added to the parsed hint so
    the retry lands *just after* the penalty clears rather than on the
    boundary. Small cushion against clock skew between client and
    server.

  → **`retryCeilingMs = 20_000`** (default, line 136). Cap on any single
    retry wait. Without this, an exponential backoff at retry 3 would
    be 40s, blowing the route's 60s budget.

  → **`maxRetries = 3`** (default, line 131). Bounded. The comment
    notes: *"Latency note: against the 60s route budget (app/api/agent),
    maxRetries=3 at ~10s each can cost ~30s on a single call, so the
    cap stays low by default."*

**Proactive spacing** (line 130, 190-194). Separately from retry, the
data source enforces a `minIntervalMs` between calls (default 200ms,
not the 10s server-side window — that's a different budget):

```typescript
private async liveCall(name, args, signal): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  // ... transport call
}
```

This is *proactive* — it ensures calls are spread, not bursty — but
not enough on its own to stay under the server's 1-per-10s limit.
The retry ladder absorbs the actual rate-limit events.

**Cache** (lines 122, 144-152, 185-186). 60-second TTL on every
successful tool-call result. Repeat calls within 60s return from
cache without hitting the server. This is the single biggest reducer
of rate-limit pressure — the agent often re-queries during a loop
(checking volume, then re-checking after a breakdown query), and
cache absorbs the repeats.

**The whole ladder in motion** for a hypothetical scenario where the
model burst-calls 3 tools in 1 second:

  1. Call 1 — fresh — runs → cached, lastCallAt = T.
  2. Call 2 — fresh, 200ms after T → liveCall waits 0ms (200ms
     elapsed), runs → rate-limit error.
  3. Retry 1 for call 2 — parsed hint says "1 per 10 second" → wait
     10s + 500ms → call succeeds, cached.
  4. Call 3 — happens after call 2's 10s wait → 10.2s after T,
     `minIntervalMs` elapsed → runs immediately → maybe rate-limited
     again (depends on server state).

In practice, the cache absorbs most repeats, so the rate-limit pressure
is much lower than the worst case. A typical 6-call investigation has
maybe 1-2 rate-limit retries; the route lands in 60-90s instead of
the worst-case 180s+.

### Move 3 — the principle

**Honor the server's stated wait. Fall back to exponential backoff
only when the server didn't say. Cap every wait at a ceiling that
keeps you inside your overall budget. Add small buffers for clock
skew.** The pattern is universal across rate-limited HTTP APIs (Stripe,
GitHub, Twitter); MCP servers happen to encode the wait inline in the
error text instead of in a `Retry-After` header.

## Primary diagram

```
  The full retry ladder for one tool call

  callTool(name, args, options)
       │
       ▼
  cache hit?
       │
  ┌────┴────┐
  │ yes     │ no
  ▼         ▼
  return    enforce minIntervalMs spacing
  cached    │
            ▼
         liveCall → transport → MCP server
            │
            ▼
         result. isRateLimited?
            │
       ┌────┴────┐
       │ no      │ yes, retries < maxRetries
       ▼         ▼
       cache    parse Retry-After hint
       result    │
       return    ▼
                hint? hint + 500ms : retryDelayMs * 2^retry
                    │
                    ▼
                cap at retryCeilingMs (20s)
                    │
                    ▼
                sleep
                    │
                    ▼
                liveCall again → loop
                    │
                    ▼
                if retries == maxRetries:
                    return last result (still error)

       finally: errors NOT cached
       (line 179-181 — don't poison the cache)
```

## Elaborate

The "parse Retry-After from error text" pattern is specific to MCP-
shaped servers that wrap errors in tool-call envelopes. For standard
HTTP APIs, `Retry-After` is a header and parsing is trivial. The
choice here is forced by the protocol shape.

The decision to NOT cache errors (line 179-181) is important. Without
it, a single rate-limit response would be cached for 60s, locking out
the tool for that period. By skipping the cache on `isError: true`,
the retry-after sleep is the only blocker, and the next call (after
the wait) hits the server fresh.

`maxRetries = 3` is conservative. Could be raised to 5 if the route
budget allowed — currently `300s` Vercel Pro budget, the diagnostic
loop typically uses ~60-90s, so there's headroom. The cap is
specifically conservative because *each* retry could burn 10s, and
six retries across a multi-tool-call agent loop could add 60s to a
single investigation.

## Project exercises

### Exercise — surface retry events on the trace wire

  → **Exercise ID:** `study-ai-eng-06-04.1`
  → **What to build:** Add a `{ type: 'retry', toolName, attemptN,
    waitMs, hintMs }` event emitted from `BloomreachDataSource.callTool`
    via the trace sink. UI shows a "rate limited, waiting Ns" indicator
    inline in the tool call row.
  → **Why it earns its place:** Today rate-limit retries are invisible
    — the tool just takes longer. Surfacing them tells the user "this
    isn't broken, the alpha server is slow."
  → **Files to touch:** `lib/data-source/bloomreach-data-source.ts`
    (accept a trace callback option), `lib/agents/aptkit-adapters.ts`
    (pass it through), `lib/mcp/events.ts`, route's `hooksFor`,
    `components/investigation/ToolCallBlock.tsx`.
  → **Done when:** A live investigation that hits rate-limit retries
    shows "retrying in 10s..." inline in the tool call row.
  → **Estimated effort:** `1–4hr`

### Exercise — add backpressure on the route's parallel request handling

  → **Exercise ID:** `study-ai-eng-06-04.2`
  → **What to build:** Vercel scales horizontally — concurrent requests
    from the same user could each hit the BloomreachDataSource's
    per-instance rate-limit handling, but they don't coordinate
    across instances. Add a per-user concurrency semaphore (e.g. via
    Vercel KV or Upstash Redis) that limits one user to N concurrent
    `/api/agent` calls at a time. Excess requests get 429'd at the
    route with a hint to retry.
  → **Why it earns its place:** Cross-instance coordination is what
    real backpressure looks like in serverless. Demonstrates "I know
    how to bound concurrency at the platform layer, not just the
    process layer."
  → **Files to touch:** new `lib/middleware/backpressure.ts`,
    `app/api/agent/route.ts` (apply middleware), env vars for KV
    connection.
  → **Done when:** Three concurrent `/api/agent` requests from the
    same session — two run, one gets 429 with a retry-after.
  → **Estimated effort:** `1–2 days`

## Interview defense

**Q: How does this codebase handle rate limits?**

Bloomreach's alpha MCP server enforces "1 per 10s" globally per user.
`BloomreachDataSource.callTool` has explicit handling: detect the
rate-limit error (regex on the result text), parse the server's
stated wait (`Retry-After ~X second(s)` or `per X second`), sleep,
retry. Up to 3 retries, each capped at 20s.

```
  detect → parse hint → wait (hint+500ms or backoff) → retry
  cap retries at 3
  cap each wait at 20s
  parallel: 60s cache absorbs repeats
  parallel: 200ms proactive spacing between calls
```

Cache is the load-bearing reducer of pressure: most agent loops
re-query data within 60s of the previous query, so the cache absorbs
the bulk of would-be repeat calls.

**Anchor line:** "Parse the server's stated wait first; exponential
backoff is the fallback. Cap each wait at 20s to keep the route
budget."

**Q: Why not cache errors?**

If an error result gets cached, every subsequent call sees the cached
error for 60s — locks out the tool. By skipping cache on
`isError: true`, the retry-after sleep is the only blocker, and the
next call after the wait hits the server fresh and (probably)
succeeds. The comment in code at line 179-181 calls this out
explicitly.

**Anchor line:** "Errors poison the cache. Skipping them is what
makes the retry ladder actually recover."

## See also

  → `04-agents-and-tool-use/02-tool-calling.md` — the layer ABOVE this
    (how tool calls get dispatched)
  → `04-agents-and-tool-use/06-error-recovery.md` — the layer that
    catches what slips through the retry ladder
  → `05-retry-circuit-breaker.md` — the next pattern (circuit breaker
    on top of retry — Case B in this codebase)

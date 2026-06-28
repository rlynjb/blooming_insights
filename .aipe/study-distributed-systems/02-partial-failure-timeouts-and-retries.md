# Partial failure, timeouts, and retries

**Industry name:** retry with backoff, deadline propagation, circuit-shaped reconnect · **Type:** Industry standard pattern, applied to a specific upstream

## Zoom out, then zoom in

The single most load-bearing distributed-systems pattern in this repo. The upstream — Bloomreach's alpha loomi-MCP server — has three failure modes that every other concern bends around: a global **~1 req/s per-user rate limit**, **OAuth tokens revoked after minutes**, and the usual transport-level transients. This file is the deep walk of how that's contained.

```
  Zoom out — where this concept lives

  ┌─ UI layer ────────────────────────────────────────────┐
  │  useReconnectPolicy()  ← reconnect on revoked token   │
  └──────────────────────────┬────────────────────────────┘
                             │ NDJSON stream
  ┌─ Service layer ──────────▼────────────────────────────┐
  │  /api/briefing · /api/agent · 300s maxDuration        │
  │  req.signal.throwIfAborted at phase boundaries         │
  └──────────────────────────┬────────────────────────────┘
                             │ HTTPS Bearer
  ┌─ Network boundary ───────▼────────────────────────────┐
  │  ★ BloomreachDataSource ★                              │ ← we are here
  │  ~1.1s spacing · 60s cache · retry honoring stated    │
  │  penalty window · 30s per-call timeout                 │
  └──────────────────────────┬────────────────────────────┘
                             │
  ┌─ Provider layer ─────────▼────────────────────────────┐
  │  Bloomreach loomi-MCP (alpha)                          │
  │  429 "rate limit reached (1 per 10 second)"           │
  │  401 invalid_token (after ~minutes)                   │
  └──────────────────────────────────────────────────────-┘
```

Pattern: **honor what the server told you, cap what it didn't, fail loudly to the human when neither helps.** The retry honors the stated penalty window if it parses; falls back to backoff if it doesn't; the timeout caps any single call; and the reconnect policy is the human escape hatch.

## Structure pass

### Axis: where does the failure originate, and where does it get contained?

```
  Failure axis traced down the stack

  Browser              — failure: client navigates away (cooperative abort)
                       — contained: server reads req.signal at every phase

  Vercel function      — failure: 300s deadline runs out
                       — contained: per-call 30s ceiling (transport.ts:38)
                                    so one stuck call can't burn the route budget

  BloomreachDataSource — failure: 429 rate limit (stated penalty window)
                       — contained: retry honoring the hint, capped at 20s,
                                    maxRetries=3

  SdkTransport         — failure: HTTP 401, fetch failed, network timeout
                       — contained: throw McpToolError(tool, detail) with the
                                    real server body (transport.ts:142)

  loomi-MCP            — failure: alpha-grade — rate limit, token revoke,
                                  intermittent "fetch failed"
                       — contained: NOTHING WE CAN DO; surface the message
```

The axis-answer flips at every layer — each one has a *different* containment strategy. That's the lesson.

### Seams (load-bearing boundaries)

- `BloomreachDataSource.callTool` ↔ `liveCall` — the retry loop wraps the single live call. Drop the wrapper and any transient 429 becomes a hard failure.
- `SdkTransport.callTool` ↔ `client.callTool` — `AbortSignal.any(routeSignal, AbortSignal.timeout(30_000))` composes the two cancel sources. Drop the timeout and one stuck call can hold the route open for 300s.
- `useReconnectPolicy.handle` ↔ NDJSON `error` event — the regex-match + sessionStorage flag is what stops an infinite reconnect loop.

### Layered decomposition: who decides to retry?

```
  "Who decides to retry?" — held constant across layers

  ┌─ UI layer ─────────────────────────────────────────┐
  │  useReconnectPolicy: regex + once-per-session flag  │   → CLIENT decides (manual + auto)
  └────────────────────────────────────────────────────┘
       ┌───────────────────────────────────────────────┐
       │ Service layer: never retries the whole stream │   → DOES NOT retry
       │ (one stream = one attempt)                    │
       └───────────────────────────────────────────────┘
            ┌──────────────────────────────────────────┐
            │ BloomreachDataSource: rate-limit retries │   → DATA-SOURCE decides
            │ only — never on transport errors         │
            └──────────────────────────────────────────┘
                 ┌─────────────────────────────────────┐
                 │ SdkTransport: fails fast on timeout │   → NEVER retries
                 │ (HTTP 0: timeout after 30000ms)     │
                 └─────────────────────────────────────┘
```

The contrast is the lesson. Each layer retries at most one thing — and only if the layer below classifies the error as "you should retry this." A timeout from `SdkTransport` is NOT retried (because the next 30s wait would just burn more of the 300s budget); a rate-limit envelope from the server IS retried (because the server told us when it would clear). This is what "smart retry" looks like.

## How it works

### Move 1 — the mental model

You know how when you write `fetch(url)` with no retry, a transient 429 means the whole request fails? The opposite extreme — retry-forever-with-exponential-backoff — has its own problem: in a per-user rate-limited world, your "exponential backoff" just trains you to wait less than the server's penalty window and burn your attempts inside it.

The right shape is: **read the server's stated penalty, wait it out exactly once with a small buffer, cap the wait at something less than your route's overall budget, give up after a small N, and let the next layer decide what to do with the failure.**

```
  Retry kernel — the pattern in one picture

      ┌──────────────────────────┐
      │ liveCall (one round trip)│
      └────────────┬─────────────┘
                   │
                   ▼
            isRateLimited(result)?
                   │
        ┌──────────┴──────────┐
        │ no                  │ yes
        ▼                     ▼
   return result      parseRetryAfterMs(result)
                            │
                  ┌─────────┴─────────┐
                  │ parsed (hintMs)   │ null (no hint)
                  ▼                   ▼
        min(hintMs+500, 20s)   min(10s × 2^(r-1), 20s)
                  │                   │
                  └─────────┬─────────┘
                            ▼
                          sleep
                            │
                            ▼
                   retries < maxRetries(3)?
                            │
                  ┌─────────┴─────────┐
                  │ yes               │ no
                  ▼                   ▼
              go to top      return last (error) result
```

That kernel is the entire pattern. The 1.1s proactive spacing is *not* part of retry — it's a pre-emptive throttle that exists so you usually don't hit the rate-limit error at all. Everything else (the cache, the timeout, the reconnect) is hardening layered on top.

### Move 2 — walk the parts

#### Part: proactive spacing (the throttle before retry)

Before the retry loop ever runs, every live call waits to keep at least `minIntervalMs` (default 1.1s) between requests. This is the "be a good citizen" part — assume the rate limit and stay just under it.

```ts
// lib/data-source/bloomreach-data-source.ts:190
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
    this.lastCallAt = Date.now();   // ← even on error, count this as "we just called"
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}
```

Two details worth naming:

- **`lastCallAt` updates even on error** (line 200). Otherwise a string of failures would keep firing back-to-back, hammering the upstream while it's already unhappy.
- **The spacing is per-instance, not per-user.** A second concurrent Vercel instance handling the same user's request *would* burst past the rate limit. This isn't fixed; the route's 60s response cache absorbs most of the duplicate work, and `connect.ts:90` sets the spacing to `1100` for the agent path. See the red-flags audit.

#### Part: classification — what is a rate-limit error here?

The server doesn't return HTTP 429. It returns HTTP 200 with `isError: true` and a content block whose text says something like `rate limit reached (1 per 10 second)`. So the classification is text-matching:

```ts
// lib/data-source/bloomreach-data-source.ts:51
function isRateLimited(result: unknown): boolean {
  if (!result || typeof result !== 'object' || (result as any).isError !== true) return false;
  const text = JSON.stringify((result as any).content ?? result);
  return /rate limit|too many requests/i.test(text);
}
```

This is what makes the retry "smart" — anything else `isError: true` returns *immediately* (no retry, no cache write — see the `isError` guard at line 179).

#### Part: parsing the stated penalty window

Two observed shapes for the server's hint:

```ts
// lib/data-source/bloomreach-data-source.ts:64
function parseRetryAfterMs(result: unknown): number | null {
  const text = JSON.stringify((result as any)?.content ?? result);
  const after = text.match(/retry[\s-]*after[^0-9]*(\d+)\s*second/i);
  if (after) return parseInt(after[1], 10) * 1000;       // "Retry after ~12 second(s)"
  const perWindow = text.match(/per\s*(\d+)\s*second/i);
  if (perWindow) return parseInt(perWindow[1], 10) * 1000; // "(1 per 10 second)"
  return null;                                              // unparseable → caller falls back
}
```

You're parsing freeform English out of an error envelope. Brittle? Yes. The right move? Also yes — the alternative is exponential backoff *blindly* into the penalty window, which is the failure mode `retryDelayMs: 10_000` exists to prevent. The 10s default is deliberately tuned to the observed `1 per 10 second` window so the fallback doesn't waste an attempt.

#### Part: the retry loop with hint + ceiling + buffer

```ts
// lib/data-source/bloomreach-data-source.ts:163
let retries = 0;
while (isRateLimited(result) && retries < this.maxRetries) {
  retries++;
  const hintMs = parseRetryAfterMs(result);
  const backoffMs = this.retryDelayMs * 2 ** (retries - 1);     // 10s, 20s, 40s
  const waitMs = Math.min(
    hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,       // RETRY_BUFFER_MS = 500
    this.retryCeilingMs,                                          // 20_000
  );
  await sleep(waitMs);
  result = await this.liveCall(name, args, options.signal);
}
```

Three load-bearing details:

- **`+ RETRY_BUFFER_MS` (500ms cushion).** Without it, the retry lands *on* the penalty boundary and a fast clock skew has you hitting another 429. With it, you land just after.
- **`retryCeilingMs: 20_000` cap.** `maxRetries=3` at 20s each can cost ~60s on a *single* call against a 300s route budget. Raising the cap risks burning the whole investigation on one rate-limit fight.
- **`signal` is threaded through the retry waits.** If the route's `req.signal` fires (client navigated away) during the `sleep`, the next `liveCall` will see the aborted signal and throw — the loop doesn't trap you in a wait you no longer care about.

#### Part: the per-call timeout (the floor under everything)

`SdkTransport.callTool` composes the caller's signal with a 30s per-call ceiling:

```ts
// lib/mcp/transport.ts:131
const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
try {
  return await this.client.callTool({ name, arguments: args }, undefined, { signal });
} catch (err) {
  if (isTimeoutError(err)) {
    throw new Error(`HTTP 0: timeout after ${TOOL_TIMEOUT_MS}ms`, { cause: err });
  }
  …
}
```

The `composeSignals` helper uses `AbortSignal.any` when available (line 173 — Node 20+). **First signal to fire wins.** The timeout is *not* retried — a 30s wait was already long; another 30s would just burn the budget. The retry ladder above only kicks in for `isError: true` rate-limit envelopes, never for a timeout.

#### Part: token revocation as a one-shot reconnect (UI layer)

Alpha Bloomreach revokes tokens after a few minutes. When that happens, the next call returns 401 with body `invalid_token`. By the time the user sees it, the NDJSON stream has already emitted `{type: 'error', message: '...invalid_token...'}`.

`useReconnectPolicy.handle` (lib/hooks/useReconnectPolicy.ts:84) is the response:

```ts
const AUTH_ERROR_RE_AUTO = /invalid_token|unauthor|forbidden|401|session expired|reconnect/i;

const handle = useCallback((msg: string): boolean => {
  if (!isAuthErrorAuto(msg)) return false;
  if (typeof window === 'undefined') return false;
  let alreadyTried = false;
  try { alreadyTried = sessionStorage.getItem(FLAG_KEY) === '1'; } catch { /* … */ }
  if (alreadyTried) {                              // already tried this session?
    try { sessionStorage.removeItem(FLAG_KEY); } catch { /* … */ }
    return false;                                  // ← give up, let the error reach the UI
  }
  try { sessionStorage.setItem(FLAG_KEY, '1'); } catch { /* … */ }
  fireReset();                                     // POST /api/mcp/reset, then reload('/')
  return true;
}, [fireReset]);
```

```
  Execution trace — the loop guard

  state.sessionStorage[FLAG_KEY]   action on auth error
  ─────────────────────────────    ─────────────────────────────
  undefined                        set FLAG, fireReset (reload)
  '1'                              remove FLAG, return false
                                   (caller shows error UI)
```

The trace makes the guard's purpose obvious: if the *new* page load also fails on auth, we don't keep reloading forever — the flag is removed and the error reaches the user as a manual "reconnect" button (the SHORT regex variant at line 34 handles that path). One auto-retry per session; manual retries are unbounded.

#### Part: error containment — McpToolError carries the real server body

The SDK's `client.callTool` throws a generic-feeling `Error` whose `cause` chain hides the actual HTTP response body. `SdkTransport.makeCapturingFetch` (`lib/mcp/transport.ts:103`) clones every non-OK response, redacts secrets, and stores the body so the throw can include it:

```ts
const captured = this.httpErrors?.last;
if (captured) {
  const body = captured.body.trim();
  throw new Error(`HTTP ${captured.status}${body ? `: ${body}` : ''}`, { cause: err });
}
```

The `redactSecrets` pass (`lib/mcp/transport.ts:66`) strips `Bearer …`, `access_token`, `refresh_token`, `id_token`, and `code_verifier` shapes before the body gets stored. Otherwise the captured body could carry a Bearer header (some failure modes attach the request envelope to `err.cause`) and reach Vercel logs.

### Move 3 — the principle

**A good retry policy is mostly classification.** The work isn't in the loop — it's in answering "what counts as transient" and "what does the server want me to do about it." Honor the hint when you can parse it, fall back to a *tight* schedule tuned to the observed reality (not the textbook 100ms-then-double), cap on a budget you actually have, and let the next layer up handle the cases your loop can't fix.

The reconnect policy is the second half of the principle: when retry has truly given up, the human is the next layer. The session-storage flag is what stops you from being clever about it.

## Primary diagram

```
  Full picture — partial failure across all layers

  ┌─ Browser ─────────────────────────────────────────────────────────┐
  │  useReconnectPolicy.handle(msg)                                    │
  │    auth-shaped error & !sessionStorage[FLAG] →                     │
  │       POST /api/mcp/reset  →  reload('/')                          │
  │    else: surface error UI with manual Reconnect button             │
  └────────────────────────────┬───────────────────────────────────────┘
                               │ NDJSON {type:'error', message}
  ┌─ /api/agent or /api/briefing route ──────────────────────────────┐
  │  try { … } catch (e) {                                            │
  │    if (e.name === 'AbortError') return;   // client cancelled     │
  │    send({type:'error', message: e.message});                      │
  │  } finally { dispose; log phases }                                │
  └────────────────────────────┬─────────────────────────────────────┘
                               │ dataSource.callTool(name,args,{signal})
  ┌─ BloomreachDataSource.callTool ──────────────────────────────────┐
  │  cache hit? → return                                              │
  │  liveCall → result                                                │
  │  while isRateLimited(result) && retries < 3 {                     │
  │     wait = min(hint+500 ?? 10s·2^r-1, 20s);                       │
  │     sleep(wait); result = liveCall                                │
  │  }                                                                │
  │  if isError → return UNCACHED                                     │
  │  else cache.set(key, result, 60s); return                         │
  └────────────────────────────┬─────────────────────────────────────┘
                               │ transport.callTool(name,args,{signal})
  ┌─ SdkTransport.callTool ──────────────────────────────────────────┐
  │  signal = AbortSignal.any(routeSignal, timeout(30_000))            │
  │  try client.callTool(…, {signal})                                  │
  │  catch timeout → throw 'HTTP 0: timeout after 30000ms'             │
  │  catch other  → throw `HTTP ${status}: ${redactedBody}`            │
  └────────────────────────────┬─────────────────────────────────────┘
                               │ HTTPS Bearer
  ┌─ Bloomreach loomi-MCP ──────────────────────────────────────────-┐
  │  200 + {isError:true, content:[{text:'rate limit ...'}]}          │
  │  401 + {error:'invalid_token', …}                                 │
  │  timeout, "fetch failed", …                                       │
  └──────────────────────────────────────────────────────────────────-┘
```

## Elaborate

The pattern here is closest to what the AWS SDK calls **"server-side throttling adaptation"** — clients honor the server's stated penalty rather than guessing. Industry adjacencies:

- **Retry-After header (HTTP)** — same idea, structured. Bloomreach's loomi-MCP doesn't use it; the hint is in the JSON body, so the parser is bespoke.
- **Circuit breaker** — *not* implemented here. The reconnect-once-per-session is a tiny piece of the same idea, but a real circuit breaker would refuse to make calls for some window after N consecutive failures. The 300s route budget makes this less necessary — the route just dies and the next one starts fresh.
- **Idempotency keys** — also *not* implemented here, because every Bloomreach tool we call is a read. See `03-idempotency-deduplication-and-delivery-semantics.md` for what would change if we wrote.
- **Deadline propagation** — the `req.signal` thread-down is the lightweight version. The real industry pattern (gRPC deadlines) computes a budget at the edge and decrements it through every hop; here we just hand the same signal down.

What to read next: Marc Brooker's "Timeouts, retries, and backoff with jitter" (AWS blog); the gRPC deadline-propagation docs; the Envoy outlier-detection docs for what a production circuit breaker looks like.

## Interview defense

**Q: "Walk me through how you handle rate limits."**

> "The upstream is alpha-grade — Bloomreach's loomi-MCP. It rate-limits per user globally at roughly 1 request per second, but the actual penalty window is stated in the error envelope as something like `1 per 10 second`. So `BloomreachDataSource.callTool` does three things: it spaces calls at ~1.1s proactively so we usually don't hit the limit; on the 200-with-isError envelope, it parses the stated window with a regex and waits `hintMs + 500ms`; and the wait is capped at 20s because the route only has 300s total budget. Max 3 retries, then it gives up."

Diagram:

```
  callTool → liveCall → rate-limited?
                          ├─ no  → cache, return
                          └─ yes → sleep(min(hint+500, 20s)) → liveCall (×3)
```

**Q: "What's the load-bearing detail people miss?"**

> "Two: First, errors are NOT cached. Line 179 of `bloomreach-data-source.ts` checks `isError` and skips the cache write — without that, a transient 429 would poison subsequent reads for the full 60s TTL. Second, `lastCallAt` updates even when a call throws, so a string of failures stays paced; otherwise we'd hammer the upstream while it's already unhappy."

**Q: "What's the failure mode if Bloomreach revokes the token mid-investigation?"**

> "The next tool call returns HTTP 401 with body `invalid_token`. `SdkTransport` wraps it as `HTTP 401: {redacted body}` and rethrows. `BloomreachDataSource.liveCall` re-throws as `McpToolError`. The route catches it, emits `{type:'error', message}` on the NDJSON stream, and the client's `useReconnectPolicy.handle` matches the auth-shaped regex, sets a `sessionStorage` flag, POSTs `/api/mcp/reset`, and reloads. If reload ALSO fails on auth, the flag is cleared and the error reaches the UI — one auto-retry per session, manual retries unbounded. That guard is the load-bearing part — without it, a permanently-broken auth setup would reload forever."

**Q: "What's missing from this design?"**

> "No real circuit breaker — if Bloomreach started failing every call, we'd still try, just with the spacing. Per-instance throttling rather than per-user — two warm Vercel instances would burst past the rate limit. And the timeout doesn't retry; that's deliberate (would burn the budget), but it does mean a slow upstream becomes a hard failure faster than necessary."

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — the 60s cache as a dedup layer.
- `04-consistency-models-and-staleness.md` — what the 60s TTL means for "what does the user see."
- `06-queues-streams-ordering-and-backpressure.md` — the NDJSON stream as backpressure surface.
- `09-distributed-systems-red-flags-audit.md` — including the per-instance throttling caveat.

# Timeouts, retries, pooling, and backpressure

**The rate-limit playbook and the AbortSignal chain** · Project-specific

## Zoom out — where this concept lives

The discipline that makes wire #2 (Service ↔ Bloomreach) survive a flaky, rate-limited alpha server inside a 300-second Vercel budget. Every defensive primitive on this wire lives here.

```
  Zoom out — the failure-handling layer of wire #2

  ┌─ UI band ──────────────────────────────────────────┐
  │  user closes tab / page errors / reconnect button  │
  └────────────────────┬───────────────────────────────┘
                       │  AbortSignal flows down…
  ┌─ Service band ─────▼───────────────────────────────┐
  │  app/api/briefing/route.ts (300s maxDuration)      │
  │  ★ AbortSignal composition, retry ladder, spacing ★│ ← we are here
  └────────────────────┬───────────────────────────────┘
                       │
                       │  spacing (~1.1s), retry on 429,
                       │  30s per-call timeout
                       ▼
  ┌─ Provider band ────────────────────────────────────┐
  │  loomi-mcp-alpha · ~1 req/s/user · alpha (revokes  │
  │  tokens, returns 429 with parseable hint text)     │
  └────────────────────────────────────────────────────┘
```

## Zoom in — the concept

Three constraints from the upstream wire:

1. **Bloomreach rate-limits per user globally.** Observed as "1 per 1 second" and "1 per 10 second" in the wild. The window is stated in the error text.
2. **Tokens revoke after minutes.** Mid-briefing 401s are normal.
3. **A hung call can burn the entire 300s route budget.** A 30s per-call timeout was added to cap that.

The discipline below is what carries the app through those constraints.

## Structure pass

### Layers

- **Route layer** — `app/api/briefing/route.ts`, `app/api/agent/route.ts`. Owns the 300s budget, the AbortSignal origin, the phase logging.
- **Data source layer** — `BloomreachDataSource` (`lib/data-source/bloomreach-data-source.ts`). Owns proactive spacing, the response cache, the rate-limit retry ladder.
- **Transport layer** — `SdkTransport` (`lib/mcp/transport.ts`). Owns the per-call 30s timeout, the signal composition, the error-body capture.
- **Reconnect layer** — `useReconnectPolicy` (`lib/hooks/useReconnectPolicy.ts`). Owns the auth-error detection + reset+reload one-shot.

### One axis held constant — `who decides this call has waited long enough?`

```
  axis = "what's the budget for one call, and who enforces it?"

  ┌─ Route (300s) ────────────┐  Vercel function maxDuration = 300s
  │ app/api/agent/route.ts:22 │  → hard ceiling; if exceeded, function killed
  └───────────────────────────┘

  ┌─ Per-call timeout (30s) ──┐  AbortSignal.timeout(TOOL_TIMEOUT_MS)
  │ lib/mcp/transport.ts:38   │  → composed inside the transport layer;
  │                           │    fails fast as "HTTP 0: timeout after 30000ms"
  └───────────────────────────┘

  ┌─ Spacing (1.1s) ──────────┐  minIntervalMs proactive wait
  │ bloomreach-data-source    │  → enforced BEFORE each call, not after a failure
  │ .ts:130-131,191-193       │
  └───────────────────────────┘

  ┌─ Retry ceiling (20s) ─────┐  retryCeilingMs caps any one wait
  │ bloomreach-data-source    │  → applies to parsed hint OR backoff,
  │ .ts:135-137,168-171       │    whichever is chosen
  └───────────────────────────┘

  ┌─ Max retries (3) ─────────┐  maxRetries on isRateLimited results
  │ bloomreach-data-source    │  → only retries successful-but-429 responses;
  │ .ts:131,164-174           │    timeouts fail fast (no retry)
  └───────────────────────────┘
```

### Seams

- **AbortSignal origin → composed signal** — `req.signal` from the route gets composed with `AbortSignal.timeout(30_000)` in the transport. First to fire wins.
- **Successful 429 result → retry** — the rate-limit response is `isError: true` *in the tool result*, not an HTTP-level failure. The retry ladder operates on the tool-result level.
- **Real network failure → no retry** — a thrown error (timeout, transport-level) does NOT retry. It surfaces as `McpToolError` immediately.

## How it works

### Move 1 — the mental model

Picture the call path as a chain of budgets. Each link has its own ceiling. The signal that the call is done — either success or "give up" — propagates up the chain.

```
  the budget chain

  ┌─ Route (300s) ─────────────────────────────────┐
  │                                                 │
  │  ┌─ Data source (spacing 1.1s + retry 3x) ────┐│
  │  │                                              ││
  │  │  ┌─ Transport (per-call 30s) ─────────────┐ ││
  │  │  │                                         │ ││
  │  │  │  ┌─ undici fetch                  ─┐   │ ││
  │  │  │  │  composed signal: route OR 30s  │   │ ││
  │  │  │  │  AbortSignal.any([…])            │   │ ││
  │  │  │  └──────────────────────────────────┘   │ ││
  │  │  │                                         │ ││
  │  │  └─────────────────────────────────────────┘ ││
  │  │                                              ││
  │  └──────────────────────────────────────────────┘│
  │                                                  │
  └──────────────────────────────────────────────────┘

  innermost wins first. the chain composes; no one layer
  has to know about the others' ceilings.
```

### Move 2 — walk each defensive primitive

#### Primitive 1 — Proactive spacing (minIntervalMs)

The simplest, fires before any call. Before talking to Bloomreach, wait until at least 1.1s has passed since the last call:

```ts
// lib/data-source/bloomreach-data-source.ts:190-205
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
    this.lastCallAt = Date.now();
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}
```

Why 1.1s and not 1.0s: Bloomreach states "1 per 1 second" — a strict 1.0s sleep risks landing on the boundary; 1.1s adds a 100ms cushion. The hard cap from Bloomreach is sometimes "1 per 10 second"; we don't proactively wait 10s (that would cost 60s for a 6-call investigation), instead we space at 1.1s and rely on the retry ladder to recover when 10s windows hit.

```
  Pattern — the spacing gate

  call 1: ────► [server]
                  │
                  ▼
                  ▼ (call 2 requested 200ms later)
                  │   elapsed = 200ms, min = 1100ms
                  │   sleep 900ms
                  ▼
  call 2:         ────► [server]
                          │
                          ▼ (call 3 requested 2000ms later)
                          │   elapsed = 2000ms, min = 1100ms
                          │   NO sleep, fire immediately
                          ▼
  call 3:                 ────► [server]
```

Proactive — fires before the call. Local — based on `this.lastCallAt`. No coordination across instances.

#### Primitive 2 — Per-call timeout (TOOL_TIMEOUT_MS)

Without this, a hung Bloomreach connection burns the entire 300s route budget on one call. The transport layer composes a 30s timeout into every call:

```ts
// lib/mcp/transport.ts:38
const TOOL_TIMEOUT_MS = 30_000;

// lib/mcp/transport.ts:129-146
async callTool(name: string, args: Record<string, unknown>, opts?: CallToolOpts): Promise<unknown> {
  if (this.httpErrors) this.httpErrors.last = null;
  const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
  try {
    return await this.client.callTool({ name, arguments: args }, undefined, { signal });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`HTTP 0: timeout after ${TOOL_TIMEOUT_MS}ms`, { cause: err });
    }
    const captured = this.httpErrors?.last;
    if (captured) {
      const body = captured.body.trim();
      throw new Error(`HTTP ${captured.status}${body ? `: ${body}` : ''}`, { cause: err });
    }
    throw err;
  }
}
```

The `composeSignals` helper (`transport.ts:173-189`) does `AbortSignal.any([routeSignal, timeoutSignal])` — first to fire wins. So either the user closes the tab (route signal) or 30s elapses (timeout signal) — either way, the in-flight `fetch` aborts.

The timeout tag is deliberately `HTTP 0:` — a status code outside the real HTTP range — so callers can recognize it without parsing the message text.

**Why no retry on timeout.** The retry ladder upstairs (`BloomreachDataSource.callTool`) only retries when the *result* is rate-limited. A thrown timeout error fails fast. A retry would just risk another 30s wait inside the same 300s budget.

#### Primitive 3 — The retry ladder

When the response comes back successfully but the *result* contains `isError: true` with a rate-limit message, retry with a wait derived from the server's stated window:

```ts
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

The hint parser handles two observed shapes:

```ts
// lib/data-source/bloomreach-data-source.ts:64-71
function parseRetryAfterMs(result: unknown): number | null {
  const text = JSON.stringify((result as any)?.content ?? result);
  const after = text.match(/retry[\s-]*after[^0-9]*(\d+)\s*second/i);
  if (after) return parseInt(after[1], 10) * 1000;
  const perWindow = text.match(/per\s*(\d+)\s*second/i);
  if (perWindow) return parseInt(perWindow[1], 10) * 1000;
  return null;
}
```

```
  Pattern — the retry ladder

  call → result has isError + "rate limit" text → retry?
                                                  │
                            ┌─────────────────────┘
                            │
                            ▼
            parse hint from text:
              "Retry after ~12 second"  → hintMs = 12_000
              "per 10 second"           → hintMs = 10_000
              (no hint)                 → backoff = 10s × 2^(retries-1)
                            │
                            ▼
            waitMs = min(hint + 500 OR backoff, 20_000)
                            │
                            ▼
            sleep(waitMs) → call again
                            │
                            ▼
            success? done.
            still rate-limited? retries++, loop (max 3)
            other error? throw.
```

The +500ms buffer (`RETRY_BUFFER_MS = 500`) is so the retry lands *just after* the penalty clears, not on its boundary. The 20_000ms ceiling (`retryCeilingMs`) caps any single wait — even if the server says "wait 60 seconds," we wait 20 and try again.

Latency math: worst case is 3 retries × 20s = 60s on a single call. Against the 300s route budget, that's 20%. If maxRetries went to 5, we'd risk burning the entire budget on retries for one call. The choice of 3 is deliberate.

#### Primitive 4 — The 60s response cache

The cheapest defense against rate limits: don't make the call at all. Repeated calls with the same `(name, args)` within 60 seconds return the cached result without touching the wire:

```ts
// lib/data-source/bloomreach-data-source.ts:144-152, 184-187
const cacheKey = `${name}:${JSON.stringify(args)}`;
const ttl = options.cacheTtlMs ?? 60_000;

if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
// …
this.cache.set(cacheKey, { result, expiresAt: now + ttl });
```

Critical detail: **errors are not cached** (`bloomreach-data-source.ts:179-181`). A 429 or 401 doesn't poison the cache; the next call retries the wire. Caching errors would make the briefing stuck-broken instead of self-healing.

This cache also bridges per-request `BloomreachDataSource` instances on a warm Vercel function: same instance, same cache. Cold start drops the cache.

#### Primitive 5 — AbortSignal composition

Already touched on; worth its own diagram. The signal travels DOWN the call stack from the route to the transport:

```
  Layers-and-hops — AbortSignal threading

  ┌─ Browser ──────────────────────────┐
  │  user closes tab                   │
  └──────────┬─────────────────────────┘
             │
             ▼  TCP FIN
  ┌─ Route ────────────────────────────┐
  │  req.signal.aborted = true         │
  │  req.signal.throwIfAborted()       │   ← coarse boundary checks
  └──────────┬─────────────────────────┘
             │  passed as { signal } into every async
             ▼
  ┌─ Data source ──────────────────────┐
  │  liveCall(name, args, signal)      │
  │  → spacing sleep is NOT signal-     │
  │    aware (small gap; see below)     │
  └──────────┬─────────────────────────┘
             │
             ▼
  ┌─ Transport ────────────────────────┐
  │  composeSignals(                    │
  │    opts.signal,                     │
  │    AbortSignal.timeout(30_000)      │
  │  )                                  │
  │  → AbortSignal.any([…])             │
  └──────────┬─────────────────────────┘
             │
             ▼
  ┌─ undici fetch ─────────────────────┐
  │  signal: composedSignal             │
  │  → on abort, socket closes (FIN/RST)│
  └────────────────────────────────────┘
```

The composer prefers `AbortSignal.any` (Node 20+, modern browsers) and falls back to a manual `AbortController` glue (`transport.ts:173-189`). Either way, the result is: the first signal to fire cancels the in-flight call.

**One small gap worth naming.** The proactive spacing sleep (`bloomreach-data-source.ts:192-194`) uses `setTimeout`, not a signal-aware sleep. If the route is aborted DURING the spacing wait, the sleep still runs to completion before the call attempt detects the abort. Worst case: a 1.1s delay on cancellation. Not load-bearing today, but a real micro-gap.

#### Primitive 6 — The reconnect policy

The other end of the recovery story. The alpha server revokes tokens after minutes; the next call comes back 401 with an `invalid_token` body. The hook detects auth-shaped errors and fires a reset+reload, with a one-shot guard so it can't loop:

```ts
// lib/hooks/useReconnectPolicy.ts:33-34
const AUTH_ERROR_RE_AUTO = /invalid_token|unauthor|forbidden|401|session expired|reconnect/i;
const AUTH_ERROR_RE_BUTTON = /unauthor|forbidden|401|session expired/i;
```

```ts
// lib/hooks/useReconnectPolicy.ts:84-111
const handle = useCallback(
  (msg: string): boolean => {
    if (!isAuthErrorAuto(msg)) return false;
    if (typeof window === 'undefined') return false;
    let alreadyTried = false;
    try {
      alreadyTried = sessionStorage.getItem(FLAG_KEY) === '1';
    } catch { /* ignore */ }
    if (alreadyTried) {
      try { sessionStorage.removeItem(FLAG_KEY); } catch { /* ignore */ }
      return false;
    }
    try { sessionStorage.setItem(FLAG_KEY, '1'); } catch { /* ignore */ }
    fireReset();
    return true;
  },
  [fireReset],
);
```

The flag is keyed `bi:reconnecting` in `sessionStorage`. If we've already tried this session and we're STILL getting auth errors, the second one is reported to the user instead of looping forever.

```
  Pattern — the one-shot reconnect

  briefing emits {type:"error", message:"… invalid_token …"}
       │
       ▼
  useReconnectPolicy.handle(msg)
       │
       ▼  matches LONG regex?
       │  ┌── no ──► return false (caller handles error normally)
       │  │
       ▼  yes
       │
       ▼  sessionStorage["bi:reconnecting"] === "1"?
       │  ┌── yes ──► clear flag, return false (don't loop)
       │  │
       ▼  no
       │
       ▼  set flag, fireReset()
       │   → POST /api/mcp/reset (drops bi_auth cookie)
       │   → window.location.href = '/'
       │   → new auth flow on next request
       └──► return true (caller bails)
```

On success (NDJSON `done` event), `clearFlag()` removes the marker so the *next* auth expiry can fire a fresh reconnect.

#### Backpressure — `not yet explicitly exercised`

We don't currently apply backpressure to the NDJSON producer. If the client is slow to read, the Node `ReadableStream.enqueue` will pile up bytes in the internal queue. In practice this hasn't been a problem because (a) the event volume is low — a few dozen events per briefing, kilobytes of payload — and (b) browsers consume `fetch` body streams fast.

A proper backpressure story would use the `pull`-based form of `ReadableStream` (`new ReadableStream({ pull(controller) { … } })`) instead of the push-based `start` form. Not exercised here.

### Move 2.5 — Phase A vs Phase B

The per-call 30s timeout was added recently. It changes the failure profile substantially.

```
  Comparison — without vs with TOOL_TIMEOUT_MS

  Without per-call timeout:                With per-call timeout (today):
  ┌──────────────────────────────┐         ┌──────────────────────────────┐
  │ one hung call can burn       │         │ one hung call fails after    │
  │ entire 300s route budget     │         │ 30s as "HTTP 0: timeout"     │
  │                              │         │                              │
  │ no fast-fail signal          │         │ caller knows network is dead │
  │                              │         │                              │
  │ retries on result-level 429   │         │ retries on result-level 429,│
  │ only                         │         │ timeouts fail fast           │
  └──────────────────────────────┘         └──────────────────────────────┘
                                                       ↑
                                              The change in transport.ts:38
                                              (PR #5 — AbortSignal support
                                              already in place, the timeout
                                              composes with it via
                                              composeSignals at line 131)
```

### Move 3 — the principle

**Layered ceilings, each layer enforcing one budget, with signal composition pulling them together.** No single layer has to know about the others' limits. The route owns 300s; the transport owns 30s/call; the data source owns the retry ladder; the reconnect policy owns auth recovery. They compose because `AbortSignal` is the shared currency — the first ceiling to fire wins, and the failure propagates upward without anyone needing to coordinate.

## Primary diagram

```
  the recap — every defensive primitive on wire #2

  ┌─ Route layer (app/api/briefing|agent/route.ts) ─────────────┐
  │                                                              │
  │  maxDuration = 300                            ← Vercel cap    │
  │  req.signal → threaded into every await        ← cancellation │
  │  console.log phases on completion              ← observability│
  │                                                              │
  └─────────────────────────────┬────────────────────────────────┘
                                │
                                │ { signal: req.signal }
                                ▼
  ┌─ Data source (BloomreachDataSource) ─────────────────────────┐
  │                                                              │
  │  60s response cache (per name+args)            ← skip wire    │
  │  minIntervalMs = 1100 (proactive spacing)      ← obey ~1 req/s│
  │  maxRetries = 3 on isRateLimited results      ← recover 429   │
  │  retryDelayMs = 10_000 fallback                ← when no hint │
  │  retryCeilingMs = 20_000 cap per wait         ← bound damage  │
  │  parseRetryAfterMs honors server hint          ← "1 per 10s"  │
  │  RETRY_BUFFER_MS = 500 cushion past boundary   ← +0.5s        │
  │  no caching on errors                          ← self-heal    │
  │                                                              │
  └─────────────────────────────┬────────────────────────────────┘
                                │
                                │ { signal }
                                ▼
  ┌─ Transport (SdkTransport) ──────────────────────────────────┐
  │                                                              │
  │  TOOL_TIMEOUT_MS = 30_000                      ← per-call cap │
  │  composeSignals(opts.signal,                                 │
  │    AbortSignal.timeout(30_000))                              │
  │  → AbortSignal.any([…])                                      │
  │                                                              │
  │  capturingFetch saves non-2xx body (redacted)                │
  │  isTimeoutError tags "HTTP 0: timeout after 30000ms"         │
  │                                                              │
  └─────────────────────────────┬────────────────────────────────┘
                                │
                                │ signal
                                ▼
  ┌─ undici fetch ──────────────────────────────────────────────┐
  │  on abort: socket FIN/RST to Bloomreach                      │
  │  keepalive pool reuses sockets across calls                  │
  └──────────────────────────────────────────────────────────────┘

  + RECOVERY (browser-side):
      useReconnectPolicy.handle(errMsg)
        → matches /invalid_token|unauthor|forbidden|401|session expired|reconnect/i
        → POST /api/mcp/reset
        → window.location.href = '/'
      one-shot guard in sessionStorage["bi:reconnecting"]
        → cleared on NDJSON {type:"done"}
```

## Elaborate

The retry ceiling at 20s and maxRetries at 3 are tuned together. 3 × 20s = 60s = 20% of the route budget. Tightening either (1 retry, 5s ceiling) would fail more often on slow Bloomreach responses; loosening either (5 retries, 60s ceiling) would risk burning the entire 300s budget on one call. The current values are a 20% headroom rule that lets a briefing of 6-8 calls complete even if a few of them hit retries.

A latent issue in the reconnect policy worth flagging: `AUTH_ERROR_RE_BUTTON` is missing `invalid_token` and `reconnect`. The hook's own comment acknowledges this:

```ts
// lib/hooks/useReconnectPolicy.ts:21-25
//  Unifying them would require manual verification against the live
//  Bloomreach server, which is not available in the current session.
//  There IS a latent bug worth flagging (the button regex is missing
//  `invalid_token` and `reconnect` matches) — filed as a future concern;
//  not this refactor's job.
```

The effect: the explicit "reconnect" button in the error UI won't *show* for an `invalid_token` error if the auto-reconnect already fired and bailed out (one-shot guard). The auto path catches that case; the manual path doesn't. A future cleanup would unify the regex.

Adjacent gap, `not yet exercised`: **no connection pool tuning at the app layer**. We rely entirely on undici's defaults. For Anthropic, where calls can be 10-50s and concurrent (intent classifier + agent), the default pool size (8) is probably fine but unmeasured. If we ever observed `socket hang up` errors clustering at high load, the first dial would be `new Anthropic({ httpAgent: new Agent({ connections: 16 }) })` or similar.

## Interview defense

**Q: Walk me through the rate-limit recovery on wire #2.**

> Three layers compose. First, proactive spacing — `minIntervalMs = 1100` in `BloomreachDataSource` enforces a 1.1s gap between calls before they're even attempted (`bloomreach-data-source.ts:192-194`). Second, if a call comes back with `isError: true` and rate-limit text in the body, the retry ladder kicks in — parse the server's stated window from the error text ("1 per 10 second"), wait that long plus a 500ms cushion, retry, up to 3 times, capped at 20s per wait. Third, a 60s response cache absorbs repeats — same `(name, args)` within 60s returns the cached result without touching the wire. Errors are never cached.

```
  on the whiteboard:

  call → cache hit? return cached
                  │
                  ▼ no
  spacing gate (≥ 1.1s since last call) → wait
                  │
                  ▼
  liveCall → result
                  │
                  ▼  isRateLimited?
                  │  yes → parse hint or backoff → wait → retry (max 3)
                  │  no  → store in cache (60s) → return
```

Anchor: spacing + retry + cache — three layers, one playbook.

**Q: What stops a hung Bloomreach call from burning the 300s budget?**

> The 30s per-call timeout in `lib/mcp/transport.ts:38`. Composed with the route-level cancel signal via `composeSignals` at line 131 — uses `AbortSignal.any([routeSignal, AbortSignal.timeout(30_000)])`. First to fire wins. When the timeout fires, undici closes the upstream socket and the call rejects. Tagged as `HTTP 0: timeout after 30000ms` so callers can recognize it without parsing the message. No retry on timeout — only result-level 429s retry — because a retry would just risk another 30s wait inside the same budget.

```
  on the whiteboard:

  callTool:
    signal = composeSignals(routeSignal, AbortSignal.timeout(30_000))
    try: await client.callTool({..., signal})
    catch:
      if (isTimeoutError) throw "HTTP 0: timeout after 30000ms"
      else if (capturedHttpBody) throw "HTTP {status}: {body}"
      else throw original
```

Anchor: 30s/call ceiling closes the worst-case route-budget exposure.

**Q: How does the browser recover from a revoked Bloomreach token?**

> The NDJSON `error` event arrives with `invalid_token` in the message. `useReconnectPolicy.handle(msg)` matches it against `AUTH_ERROR_RE_AUTO` (line 33). If matched and we haven't already tried this session, set a sessionStorage flag (`bi:reconnecting`), `POST /api/mcp/reset` to drop the encrypted `bi_auth` cookie, then `window.location.href = '/'` to reload. The reload triggers fresh OAuth. On the next successful stream completion, `clearFlag()` removes the marker so a *future* auth expiry can fire a fresh reconnect. The one-shot guard prevents an infinite loop if re-auth also fails.

```
  on the whiteboard:

  NDJSON {type:"error", message:"… invalid_token …"}
      │
      ▼
  useReconnectPolicy.handle(msg)
    match LONG regex? yes
    sessionStorage["bi:reconnecting"]? no
    → set flag, POST /api/mcp/reset, window.location.href = '/'
```

Anchor: one-shot reset+reload, guarded against loop.

**Q: What's the biggest networking risk this app still carries?**

> The two-regex split in `useReconnectPolicy`. `AUTH_ERROR_RE_AUTO` matches `invalid_token|unauthor|forbidden|401|session expired|reconnect`; `AUTH_ERROR_RE_BUTTON` is missing `invalid_token` and `reconnect`. The hook's own comment flags it. The auto-reconnect path handles the case correctly; the manual button doesn't. Effect: if a user's auto-reconnect fails and they're shown the error UI, the "reconnect" button might not render for an `invalid_token` error specifically. Real bug, low blast radius (the auto path catches the common case). The fix is to unify the regexes, which requires verifying against live Bloomreach behavior — not done yet.

Anchor: the latent bug the code itself names.

## See also

- `01-network-map.md` — wire #2 on the map
- `03-tcp-udp-connections-and-sockets.md` — what AbortSignal does at the socket level
- `05-http-semantics-caching-and-cors.md` — what 401/429/500 mean to the client
- `08-networking-red-flags-audit.md` — this file's findings, ranked by risk

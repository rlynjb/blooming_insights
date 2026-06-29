# 07 · Timeouts, retries, pooling, and backpressure

## Subtitle

How the app survives slow servers, rate limits, and overload — Industry standard.

## Zoom out, then zoom in

There are four budgets stacked in this app: a 300s route-level ceiling (Vercel Pro `maxDuration`), a 30s per-MCP-call ceiling (the transport timeout), a 1.1s spacing between calls (the rate-limit proactive pacing), and a 60s in-process response cache. The per-call 30s ceiling is the load-bearing one — without it, one stuck Bloomreach call would burn the whole 300s route budget and the user sees a 5-minute blank screen.

```
  Zoom out — where each budget bites

  ┌─ UI layer ──────────────────────────────────────────────────┐
  │  browser fetch — no client-side retry, no client timeout    │
  │  (relies on the server closing the stream cleanly)          │
  └────────────────────────────────────────────────────────────┘
                            │
                            ▼
  ┌─ Service layer ─────────────────────────────────────────────┐
  │  ★ 300s route ceiling ★    maxDuration on /api/briefing,    │
  │                              /api/agent (Vercel Pro max)    │
  │                                                              │
  │   per request:                                              │
  │   60s response cache       (Map in BloomreachDataSource)     │
  │   1.1s call spacing         (minIntervalMs)                  │
  │   rate-limit retry ladder  (parseRetryAfterMs + retry loop) │
  │                                                              │
  │   per call:                                                 │
  │   ★ 30s timeout ★          (AbortSignal.timeout in transport)│
  │   composed with             req.signal via composeSignals    │
  └────────────────────────────────────────────────────────────┘
```

The structure is concentric: a wider budget contains a stack of narrower ones. Whichever fires first wins. The 30s per-call is the inner ring; the 300s route is the outer.

## Structure pass

  - **Layers** — route budget, per-call budget, retry budget, spacing budget, cache budget.
  - **Axis traced — "what does each budget protect?"** Flips at each layer:
      - 300s route budget protects **Vercel** from runaway functions.
      - 30s per-call budget protects **the route** from one stuck upstream call.
      - Retry ladder protects **the user** from transient failures (rate-limit blips).
      - 1.1s spacing protects **Bloomreach** from us (and protects us from triggering its global rate-limit penalty).
      - 60s response cache protects **the user's latency budget** from repeat calls in one investigation.
  - **Seams** — the load-bearing one is the **`composeSignals` boundary** at `lib/mcp/transport.ts:131,150`. That's where the per-call 30s timeout gets ORed with the route's client-cancel signal, so whichever fires first cancels the in-flight call. Drop that and you either have a hung call (no timeout) or a request that ignores the user's cancel (no compose).

## How it works

### Move 1 — the mental model

The whole story is "many budgets, one cancellation primitive." Each layer creates an `AbortSignal`; the inner layer composes its signal with the outer layer's signal; the first one to fire cancels the chain.

```
  Pattern — composed budgets, OR-style cancellation

  outer: route req.signal           (300s · client-close · navigate-away)
                │
                │  composed with     ──┐
                │                       │  AbortSignal.any([outer, inner])
                ▼                       │  → fires when EITHER fires
  inner: AbortSignal.timeout(30_000)  ──┘
                │
                ▼
  passes into MCP SDK callTool({signal})
                │
                ▼
  passes into undici fetch({signal})
                │
                ▼
  cancels TCP read; throws AbortError
```

The cancellation primitive is one `AbortController.signal`, plumbed all the way down to the actual network read. Every layer that creates a timeout produces a fresh signal; `composeSignals` ORs them. The MCP SDK is signal-aware. Undici is signal-aware. The whole stack respects the same primitive.

### Move 2 — the moving parts

#### The 30s per-call timeout — the load-bearing piece

```ts
// lib/mcp/transport.ts:38
const TOOL_TIMEOUT_MS = 30_000;
```

Why 30s specifically? The route budget is 300s. The agent loop typically runs 6-10 Bloomreach calls per investigation. If any one call hangs (network blip, server hang, container restart), 30s is short enough that the rest of the loop can still complete inside 300s. The math: 30s × 1 stuck call + ~5s × 9 healthy calls + Anthropic time ≈ 100-120s — well inside budget.

The actual composition happens in `SdkTransport.callTool`:

```ts
// lib/mcp/transport.ts:129-145
async callTool(name, args, opts) {
  if (this.httpErrors) this.httpErrors.last = null;
  const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
  //                            ▲                ▲
  //                            │                │ inner: per-call ceiling
  //                            │ outer: route's req.signal (or undefined)
  try {
    return await this.client.callTool({ name, arguments: args }, undefined, { signal });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`HTTP 0: timeout after ${TOOL_TIMEOUT_MS}ms`, { cause: err });
      //               ▲
      //               │ distinct tag so callers can recognize timeout vs 5xx
    }
    // … HTTP error body capture …
  }
}
```

The `HTTP 0:` tag is a deliberate signal — it's not a real HTTP status; it's the conventional "this isn't an HTTP failure, it's a network/transport failure" code. The McpClient's retry ladder uses this to fail-fast instead of retrying (a timeout-retry would just risk another 30s wait inside the same route budget).

#### `composeSignals` — the OR-combinator

```ts
// lib/mcp/transport.ts:173-189
export function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const filtered = signals.filter((s): s is AbortSignal => !!s);
  if (filtered.length === 0) return new AbortController().signal;       // ← never aborts
  if (filtered.length === 1) return filtered[0];                          // ← passthrough
  if (typeof (AbortSignal as unknown as { any?: unknown }).any === 'function') {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(filtered);
  }
  // Fallback for older runtimes:
  const ac = new AbortController();
  for (const s of filtered) {
    if (s.aborted) { ac.abort((s as unknown as { reason?: unknown }).reason); return ac.signal; }
    s.addEventListener('abort', () => ac.abort((s as unknown as { reason?: unknown }).reason), { once: true });
  }
  return ac.signal;
}
```

Three paths:

  - **`AbortSignal.any([...])`** — the modern primitive (Node 20+, modern browsers). Returns a signal that fires when any input fires. The right tool when available.
  - **Manual `AbortController` glue** — the fallback. Listens on each input; aborts the controller when any one fires. Belt-and-braces for older runtimes; today it's effectively dead code in the supported environments, but it's there.
  - **Edge cases** — zero signals returns a never-firing signal; one signal returns the signal itself (no allocation).

This is the single most-reused primitive in the transport layer.

#### Rate-limit spacing — 1.1s proactive

```ts
// lib/data-source/bloomreach-data-source.ts:190-205
private async liveCall(name, args, signal?: AbortSignal): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {                                    // ← default 1.1s
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  try {
    const result = await this.transport.callTool(name, args, { signal });
    this.lastCallAt = Date.now();
    return result;
  } catch (err) {
    this.lastCallAt = Date.now();                                        // ← updated even
    throw new McpToolError(name, errorDetail(err), { cause: err });      //   on error so
  }                                                                       //   a fail-then-
}                                                                         //   retry still
                                                                          //   spaces
```

The 1.1s comes from `connect.ts:97` where `minIntervalMs: 1100` is passed in. Bloomreach states "1 per 1 second" sometimes and "1 per 10 second" other times in its error envelopes — the proactive 1.1s targets the friendlier window. The deeper retry ladder honors the stated 10s window when it gets one back.

Why 1.1s and not 1s? A 100ms cushion so the request lands *after* the second has rolled over, not on its boundary (where a clock skew between the app and Bloomreach could put us inside the previous second).

#### The retry ladder — parse-the-window-and-wait

```ts
// lib/data-source/bloomreach-data-source.ts:163-174
let retries = 0;
while (isRateLimited(result) && retries < this.maxRetries) {
  retries++;
  const hintMs = parseRetryAfterMs(result);                              // ← parse the
  const backoffMs = this.retryDelayMs * 2 ** (retries - 1);              //   server's
  const waitMs = Math.min(                                                //   stated
    hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,                //   penalty
    this.retryCeilingMs,                                                  //   window
  );
  await sleep(waitMs);
  result = await this.liveCall(name, args, options.signal);
}
```

The `parseRetryAfterMs` (`lib/data-source/bloomreach-data-source.ts:64`) reads two known shapes:

```ts
//   "Retry after ~12 second(s)"            → 12_000
//   "rate limit reached (1 per 10 second)" → 10_000  (the penalty window)
```

If neither is present, it returns `null` and the caller falls back to exponential backoff off `retryDelayMs` (default 10s, doubling per retry, capped at `retryCeilingMs: 20_000`).

The 500ms `RETRY_BUFFER_MS` cushion makes the retry land just *after* the penalty window closes, not on its boundary.

The math against the 60s route budget (Hobby) or 300s (Pro):
  - `maxRetries=3` × `~10s parsed wait` = up to 30s on a single rate-limited call.
  - Plus the original call's elapsed time.
  - Plus any spacing on subsequent calls.
  - On Hobby (60s), one fully rate-limited call could blow the budget. On Pro (300s), there's headroom.

#### The 60s response cache — protecting the user from re-asking

```ts
// lib/data-source/bloomreach-data-source.ts:144-153
const cacheKey = `${name}:${JSON.stringify(args)}`;
const ttl = options.cacheTtlMs ?? 60_000;                                // ← default 60s

if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

Per-process `Map`, not shared across instances. The agent loop within one investigation often asks the same EQL twice (a hypothesis check that mirrors the original metric, say). 60s is long enough to capture that intra-investigation reuse; short enough not to serve stale data across separate user sessions.

Two safeguards:

  - **Errors aren't cached** (`bloomreach-data-source.ts:178-181`) — `{isError: true}` results skip the cache write so a transient failure doesn't poison subsequent calls.
  - **`skipCache: true`** (used by `/api/mcp/call`) bypasses the read but still does a write-through. Lets the debug page force-refresh while warming the cache for any agent that follows.

#### The 300s route budget — the outer ring

```ts
// app/api/briefing/route.ts:19
export const maxDuration = 300;
// app/api/agent/route.ts:22
export const maxDuration = 300;
```

300s is Vercel Pro's ceiling. Beyond that, Vercel terminates the function regardless of what the app wants. The route's `req.signal` fires when the user closes their tab; both signals end up as `req.signal.throwIfAborted()` checkpoints inside the agent loop:

```ts
// app/api/briefing/route.ts:215, 248, 259, 283
req.signal.throwIfAborted();
```

These are at coarse phase boundaries — between `schema_bootstrap`, `coverage_gate`, `list_tools`, `monitoring_scan`, `insight collection`. Not inside the agent loop's individual tool calls, because the per-call signal composition already handles cancellation there.

#### What's NOT done

  - **No client-side timeout on the browser fetch.** Both `useBriefingStream` and `useInvestigation` call `fetch(url)` with no `AbortSignal` and no timeout. They rely on the server closing the stream within 300s.
  - **No retry on 5xx from the route.** The hooks surface the error to the page; the user (or the auth-shaped reconnect policy) decides what to do.
  - **No circuit breaker.** Repeated Bloomreach failures don't trip a "stop trying for N minutes" gate. The user retries by clicking refresh.
  - **No connection pool the app owns.** Undici pools outbound fetch keep-alive sockets per origin (default 256), which is fine for two upstreams at this volume. The Bloomreach connection is per-route-request (not pooled across requests) — see `03-tcp-udp-connections-and-sockets.md`.
  - **No backpressure check on the writer side.** `controller.enqueue(...)` doesn't poll `desiredSize`. The runtime buffers. Acceptable for this app's volumes (tens of events per investigation, each <2KB after truncation by `trunc(v)` at 4KB).
  - **No request collapsing.** Two simultaneous fetches for the same insight on different tabs would trigger two agent runs. Not a real problem in practice (the user has one tab) but not architecturally prevented either.

#### Backpressure — the implicit story

The route's `ReadableStream` writer pattern is:

```ts
controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
```

It never awaits anything backpressure-related. If the browser's read is slow, the runtime (Vercel's edge + Node's stream layer) buffers in memory. For this app's profile (one user, ~30 small events per stream), the buffer is bounded and small. For an app that fan-outs thousands of events per stream to a slow reader, you'd want to poll `controller.desiredSize` and `await` when it goes negative — but that's a problem this app doesn't have.

Likewise, the consumer side (`readNdjson`) doesn't ack or flow-control. It reads as fast as bytes arrive. The implicit backpressure is TCP's own window — if the consumer can't keep up, the kernel's receive buffer fills, the window shrinks, the sender stalls. All of that is transparent to the app.

### Move 3 — the principle

A timeout you don't have is a budget you can lose entirely. The non-obvious version: every async call your code makes is implicitly an infinite timeout unless you wire one in. The fix is to make the cancellation primitive (`AbortSignal`) the *only* way work happens, then compose it at every layer that has a budget. Once that pattern is in place, adding a new budget is one `composeSignals` call; removing one is deleting a line. Without it, every new budget needs custom wiring at every layer, and the layers drift.

## Primary diagram

```
  Full budget stack — concentric, OR-cancellation

  ┌─ 300s — Vercel route maxDuration ────────────────────────────────┐
  │  fires: Vercel terminates the function                            │
  │                                                                   │
  │  ┌─ ~ — req.signal (client cancel) ─────────────────────────────┐ │
  │  │  fires: user closes tab / navigates away                     │ │
  │  │                                                              │ │
  │  │  ┌─ 30s — per-call AbortSignal.timeout ────────────────────┐ │ │
  │  │  │  fires: one MCP call exceeds its budget                  │ │ │
  │  │  │  composed: composeSignals(req.signal, AbortSignal.timeout)│ │ │
  │  │  │                                                          │ │ │
  │  │  │  ┌─ 1.1s spacing — minIntervalMs ──────────────────────┐ │ │ │
  │  │  │  │  every call waits this long since the previous one  │ │ │ │
  │  │  │  │                                                      │ │ │ │
  │  │  │  │  if rate-limited: retry ladder (max 3)               │ │ │ │
  │  │  │  │   wait = min(parsedWindow + 500ms                    │ │ │ │
  │  │  │  │          or  retryDelayMs × 2^(n-1),                 │ │ │ │
  │  │  │  │          retryCeilingMs)                             │ │ │ │
  │  │  │  │                                                      │ │ │ │
  │  │  │  │  60s response cache: skip the call entirely          │ │ │ │
  │  │  │  │   if same name+args within 60s                       │ │ │ │
  │  │  │  └──────────────────────────────────────────────────────┘ │ │ │
  │  │  └──────────────────────────────────────────────────────────┘ │ │
  │  └──────────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────────┘

  Whichever ring fires first wins. The signal propagates through:
   composeSignals → MCP SDK → undici fetch → TCP read cancel → AbortError
```

## Elaborate

The version of this story that's worth dwelling on is what happens when Bloomreach hits the 10-second rate-limit window mid-investigation. The agent has made 3 calls successfully, then the 4th comes back `{isError: true, content: "rate limit reached (1 per 10 second)"}`. The retry ladder kicks in:

  1. `parseRetryAfterMs` finds `(1 per 10 second)` → returns 10000.
  2. `waitMs = min(10000 + 500, 20000) = 10500`.
  3. Sleep 10.5s.
  4. Re-call `liveCall`. Spacing check: the 10.5s wait already covered the 1.1s spacing requirement, so no extra wait.
  5. Call succeeds. `lastCallAt` updates.

Total time cost on this one call: ~11 seconds. Against the 300s budget, that's manageable. Against the 60s Hobby budget, it would be ~18% of the entire request. That's why `maxDuration = 300` is non-negotiable for this app.

The decision to use the parsed window rather than fixed backoff is the right one because Bloomreach actually *tells* you how long to wait. Honoring the hint hits the retry exactly when the penalty clears; backoff would either wait too short (and trigger another rate-limit) or too long (and waste budget). The 500ms cushion is the cheap-insurance bit.

The piece that's slightly fragile: `parseRetryAfterMs` is regex-based against two known shapes. If Bloomreach rotates the error envelope wording, the regex breaks and the code falls back to backoff — which still works, just less efficiently. A more robust version would parse a structured `retry-after`-shaped field on the error envelope; today the envelope is text only.

The 60s cache is the unsung hero of the latency budget. A typical investigation asks ~6 EQLs, and the agent often re-runs the same one (the original-metric query, again, to confirm a hypothesis). Without the cache, that's another 1.1s spacing + 500ms-1s query time. With it, 0ms. Across an investigation that's 2-3s saved.

## Interview defense

**Q: How does the per-call timeout compose with the route's client-cancel signal?**

```
   req.signal (client cancel)         AbortSignal.timeout(30_000)
        │                                       │
        └─────────► composeSignals ◄────────────┘
                          │
                          ▼
                  AbortSignal.any([req.signal, timeout])
                          │
                          ▼
                  pass into client.callTool({ signal })
                          │
                          ▼
                  if either fires → fetch abort → AbortError
```

**Anchor:** whichever fires first wins. Without composition you'd either ignore the user (timeout-only) or have a hung call (cancel-only). Both budgets are real; both need a vote.

**Q: Why is the per-call timeout 30s when the route budget is 300s?**

Because the agent makes ~6-10 calls per investigation. Even one stuck call shouldn't cost more than 10% of the route's budget. 30s × 1 hung call + 5s × 9 healthy + ~30s Anthropic = ~105s. Comfortably under 300s. Set it to 60s and one hang costs ~150s — too close to the limit.

**Q: What's the load-bearing part of the timeout/retry story?**

Three pieces, in priority order: (1) the 30s per-call timeout, because without it one stuck call eats the whole budget; (2) `composeSignals`, because the timeout is useless if the user can't cancel; (3) the parsed-window retry, because guessing the wait time burns budget and triggers more rate-limits.

The interview shibboleth: most engineers would name "the 300s maxDuration" as the load-bearing piece because it's the most visible. The real answer is the inner 30s ceiling — the outer one is just "what Vercel sells me," the inner one is "what I designed."

## See also

  - `06-websockets-sse-streaming-and-realtime.md` — for what's happening on the wire while these budgets tick.
  - `03-tcp-udp-connections-and-sockets.md` — for the connection-pooling layer that lives below the per-call timeout.
  - `08-networking-red-flags-audit.md` — for the ranked risks if any of these budgets misfire.
  - `.aipe/study-distributed-systems/` — for the partial-failure version of this story (what happens when Bloomreach is down, not just slow).

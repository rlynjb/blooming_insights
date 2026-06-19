# 02 — partial failure, timeouts, retries

**Industry name(s):** partial failure handling · bounded retry · server-hint backoff · rate-limit cooperation
**Type:** Industry standard · Language-agnostic

> **Verdict-first:** the load-bearing distributed-systems mechanism in this app is `BloomreachDataSource`'s retry loop in `lib/data-source/bloomreach-data-source.ts:164-174`. It parses Bloomreach's *own* "Retry after ~N seconds" hint out of the 429 body, waits that long plus a 500ms cushion, and bounds itself by `maxRetries=3` and `retryCeilingMs=20_000`. This is genuine partial-failure engineering. The real weaknesses still standing: **no per-call timeout on the MCP call** (a hung connection burns the route's whole 300s budget), and **no retry at all on Anthropic** or on non-429 MCP transport errors. The earlier Phase-2 design with two adapters (`OlistDataSource` had a per-call 30s `AbortSignal.timeout`, framing the per-tool-timeout gap as adapter-asymmetric) is gone — PR #8 deleted `OlistDataSource` on 2026-06-18. The gap is no longer asymmetric; it's just open.

---

## Zoom out, then zoom in

Every partial-failure mechanism in this app lives at the service ↔ provider seam. Files 03 (idempotency), 04 (consistency), and 09 (red-flags) all attach back to this box.

```
  Zoom out — where retries and timeouts happen

  ┌─ UI layer ───────────────────────────────────────────┐
  │  reconnect-once on 401 (app/page.tsx)                 │
  └─────────────────────────┬────────────────────────────┘
                            │
  ┌─ Service layer ─────────▼────────────────────────────┐
  │  ★ BloomreachDataSource.callTool — retry loop ★       │ ← we are here
  │       (parses 429 hint; bounded by maxRetries=3)      │
  │       NO per-call timeout                             │
  │  agent loop: NO retry on Anthropic                    │
  │  SyntheticDataSource: in-process, no failure path     │
  └─────────────────────────┬────────────────────────────┘
                            │
  ┌─ Provider layer ────────▼────────────────────────────┐
  │  Bloomreach MCP   (429 with retry hint; network)      │
  │  Anthropic        (no special handling in our code)   │
  └──────────────────────────────────────────────────────┘
```

**Zoom in.** The question this file answers: *when an external partner fails partially, how does the app decide whether to wait, retry, or fail fast — and how long to do it for?* On the Bloomreach side: **Bloomreach tells you how long to wait, in plain English, in the error body** — cooperate with that hint and you survive. The in-process `SyntheticDataSource` adapter doesn't cross a hop, so partial failure isn't a question there.

---

## Structure pass

**Layers.** Two interesting ones: the in-process retry loop (your code) and the external rate-limit window (their code). The route's 300s `maxDuration` is the outer bound on everything.

**Axis: failure containment.** Hold one question across both layers: *where does a 429 get contained, and what does the layer above it see?* The MCP server emits 429 → `SdkTransport` (`lib/mcp/transport.ts:47-59`) returns it as a normal tool result with `isError: true` → `BloomreachDataSource` (`lib/data-source/bloomreach-data-source.ts:164`) detects it via regex on the body and *contains* the failure inside its retry loop → the agent loop sees either a successful result or eventually an `isError: true` it surfaces as a tool error. Failure containment lives entirely inside the adapter. Above it, no one knows a retry happened.

**Seams.** Two. **Inside `BloomreachDataSource`**, the seam between `callTool` (which retries) and `liveCall` (which spaces but doesn't retry). **Above the adapter**, the seam where retries become invisible — the agent loop never sees the retry count, only the final outcome. Below the adapter, the only seam is HTTP itself: every 429 carries a body the code reads to decide the next move.

```
  Structure pass — failure containment, one distributed adapter

  ┌─ agent loop ───────────────────────────────────────────┐
  │  sees: success result OR isError result                 │
  │  knows: nothing about retries or timeouts               │
  └─────────────────────┬──────────────────────────────────┘
                        │  callTool returns (uniform shape)
                        ▼
  ┌─ BloomreachDataSource ─────────────────────────────────┐
  │ while (isRateLimited && retries < max):                 │
  │   waitMs = parseRetryAfterMs ?? backoff                 │
  │   sleep(min(waitMs, ceiling))                           │
  │   retry                                                 │
  │ ★ RATE-LIMIT CONTAINED ★                                 │
  │ no per-call timeout — a hang escapes to the route's      │
  │ 300s budget                                              │
  └────────┬───────────────────────────────────────────────┘
           │  HTTP+SSE
           ▼
  ┌─ Bloomreach MCP ─────────┐
  │ 200 isError + body text   │
  │ with retry hint           │
  └───────────────────────────┘
```

The containment is intentional. The agent loop is built to compose dozens of tool calls; bubbling a transient 429 up to the loop would force every agent to know about rate limits. Containing it at the adapter layer is the right altitude — and the `DataSource` interface above the adapter means the agent never has to switch on backend (today there's only one distributed backend; the seam stays shaped for more).

---

## How it works

### Move 1 — the mental model

You already know `fetch()` with a `try/catch`. A retry-on-rate-limit loop is just a `while` around that `fetch`, with three knobs: *how long do you wait before retrying*, *what's your max number of retries*, and *what's the cap on any single wait so you don't sleep forever*. The trick in this codebase is that knob #1 is read from the server's response — the server tells you exactly how long to wait, and the code believes it.

```
  The retry kernel — the smallest thing that's still the pattern

  result = call()
  while isRateLimited(result) and retries < max:
    wait_ms = parse_hint(result) ?? backoff(retries)
    wait_ms = min(wait_ms, ceiling_ms)           ← cap any single sleep
    sleep(wait_ms)
    result = call()
    retries += 1
  return result                                  ← success or final 429
```

Five parts. Remove any one and the loop breaks in a specific way:
- **the predicate** (`isRateLimited`) — without it, you can't distinguish "rate-limited, retry" from "real error, don't retry"
- **the bound** (`retries < max`) — without it, a perpetually-throttling server livelocks the caller
- **the wait** (`parse_hint || backoff`) — without it, you retry instantly and immediately re-trigger the same window
- **the ceiling** (`min(..., ceiling_ms)`) — without it, a server hint like "retry after 600 seconds" hangs the whole request
- **the rebind** (`result = call()` again) — without it, the loop checks the same result forever

### Move 2 — the moving parts

#### Part 1 — the detection predicate

You already know how to check `res.status === 429`. This codebase can't, because MCP returns 429s as **HTTP 200 with `isError: true` in the JSON body**. The server's rate-limit signal is *inside* the success envelope, not at the HTTP layer.

```
  Detection — peer inside the success body

  result = await transport.callTool(...)    ← HTTP 200 OK
  if result.isError === true:               ← MCP-level error flag
    text = JSON.stringify(result.content)
    if /rate limit|too many requests/i.test(text):
      → this is a 429 in disguise; retry
    else:
      → genuine tool error; don't retry, surface
```

The boundary condition: any genuine tool error whose text happens to contain "rate limit" would be wrongly retried. In practice this is fine — Bloomreach only puts those words in actual 429 bodies — but it's a coupling to the server's error phrasing, not its status code.

#### Part 2 — the hint parser

You already know regex. The wait time comes from the body itself. Two shapes are observed:

```
  Hint parsing — the two shapes in the wild

  shape 1:  "Retry after ~12 second(s)"               → 12_000 ms
            /retry[\s-]*after[^0-9]*(\d+)\s*second/i

  shape 2:  "rate limit reached (1 per 10 second)"    → 10_000 ms
            /per\s*(\d+)\s*second/i

  fallback: no parseable hint                         → null
            (caller uses exponential backoff)
```

Why parse? Because the server is telling you exactly how long the window is, and respecting that gets you through it in *one* retry instead of guessing wrong twice. The penalty for guessing too short is *another* 429 that pushes the window further out; the penalty for guessing too long is unnecessary latency. The hint kills both.

#### Part 3 — the wait calculation

The full calculation combines the parsed hint with exponential backoff as a fallback, and caps both:

```
  Wait calculation — pseudocode, one operation per line

  hint_ms = parse_retry_after_ms(result)              ← null if absent
  backoff_ms = retry_delay_ms * (2 ** (retries - 1))  ← 10s, 20s, 40s, …
  base_wait = (hint_ms != null)
              ? hint_ms + RETRY_BUFFER_MS              ← 500ms cushion past
              : backoff_ms                                the stated window
  wait_ms = min(base_wait, retry_ceiling_ms)          ← capped at 20_000
  sleep(wait_ms)
```

The cushion matters. If you retry *at* the boundary of the window, the server may still be measuring inside the previous window — you'd 429 again. Add 500ms of slack and the next call lands cleanly outside.

#### Part 4 — the bound

`maxRetries = 3` and `retryCeilingMs = 20_000`. The math:

```
  Retry budget — worst case per call

  attempts:    1 (initial) + 3 (retries)        = 4
  total wait:  up to 3 × 20_000 ms              = 60_000 ms
  per-call total worst case                     = ~60s

  vs the route's maxDuration                    = 300_000 ms

  → one rate-limited tool call can spend 20% of the
    route's entire budget. An investigation with 6
    tool calls all rate-limited would spend 360s
    on waits alone, which is over budget.
```

This is why proactive spacing matters — file 02 of `study-system-design/` walks the choice. By spacing every live call ~1.1s apart, the code makes the *first* attempt usually succeed, so the retry path is the exception not the rule.

#### Part 5 — the per-call spacing (separate from retry)

The other half of the partial-failure story is *avoiding* the 429 in the first place. `BloomreachDataSource.liveCall` (`lib/data-source/bloomreach-data-source.ts:190-205`) tracks `lastCallAt` and sleeps to ensure at least `minIntervalMs` (1100ms in production) between any two calls.

```
  Proactive spacing — keep below the rate-limit window

  ┌─ McpClient ─────────────────────────────────────────────┐
  │                                                          │
  │   lastCallAt   ─── timestamp of the most recent call     │
  │                                                          │
  │   liveCall(name, args):                                  │
  │     elapsed = now - lastCallAt                            │
  │     if elapsed < minIntervalMs:                           │
  │       sleep(minIntervalMs - elapsed)                      │
  │     result = transport.callTool(...)                      │
  │     lastCallAt = now                                      │
  │     return result                                         │
  │                                                          │
  └──────────────────────────────────────────────────────────┘

  per-instance only. Two Vercel instances each track their own
  lastCallAt — and Bloomreach's limit is GLOBAL per user, so
  two parallel instances for one user can still trigger the limit.
```

The boundary condition: spacing is per-process. Two Vercel instances running concurrent briefings for the same user each think they're respecting the limit; together, they aren't. This is a Seam B problem (file 01) leaking into the partial-failure layer.

#### Part 6 — what NOT YET EXERCISED looks like

Four pieces of standard partial-failure tooling are absent on purpose or by accident.

- **No per-call timeout on `transport.callTool`.** `BloomreachDataSource.liveCall` awaits it without a `Promise.race` against a timer. A hung MCP connection would consume the route's whole 300s budget silently. The only ceiling is `maxDuration = 300` on the route. This is the gap most worth closing first. (Historical note: the earlier `OlistDataSource` adapter composed `AbortSignal.timeout(30_000)` onto every call, which framed this as adapter-asymmetric. With Olist removed in PR #8, the gap is no longer asymmetric — it's just open on the one remaining distributed adapter.)
- **No retry on transport errors.** A 401, 500, or network error is thrown as `McpToolError` (`lib/data-source/bloomreach-data-source.ts:101-110, 195-205`) immediately, with no retry. The reasoning is sound — a 401 won't fix itself by retrying — but a transient 500 or DNS blip is also non-retried.
- **No circuit breaker.** If Bloomreach starts failing every call, the code keeps trying every call. No "open the circuit after 5 failures, fast-fail for 30 seconds" pattern. At hackathon scale this is fine; at production scale you'd add one.
- **No retry on Anthropic.** `anthropic.messages.create()` is awaited directly in `runAgentLoop` (`lib/agents/base.ts:102`) with no wrapper. Anthropic's SDK may retry internally; the codebase doesn't add any. (Inferred — not observed in the code.)

### Move 3 — the principle

**The strongest partial-failure mechanism is the one where the server tells you what to do and you do it.** Backoff schedules are guesses; parsed retry hints are facts. When the protocol you're calling exposes the rate-limit window in the response — whether it's `Retry-After` in HTTP, `X-RateLimit-Reset`, or (as here) prose in the error body — read it, respect it, add a small cushion, and cap any single wait so a hostile or buggy server can't hang you. Everything else (exponential backoff, jitter, circuit breakers) is what you reach for when the server *doesn't* tell you. Bloomreach tells you. The code listens.

---

## Primary diagram

```
  McpClient.callTool — the full retry loop

  ┌─ caller (agent loop) ────────────────────────────────────────┐
  │   mcp.callTool('execute_analytics_eql', { eql: '...' })      │
  └─────────────────────────────┬────────────────────────────────┘
                                ▼
  ┌─ McpClient.callTool ─────────────────────────────────────────┐
  │                                                                │
  │   1) cache check                                               │
  │      cacheKey = `${name}:${argsJson}`                          │
  │      if cached && expiresAt > now → return { fromCache: true } │
  │                                                                │
  │   2) live call (with spacing)                                  │
  │      result = liveCall(name, args)  ──┐                       │
  │                                        ▼                       │
  │   3) retry loop ──────────────────┐  ┌─ liveCall ───────────┐  │
  │      retries = 0                  │  │ elapsed = now -       │  │
  │      while isRateLimited(result)  │  │   lastCallAt          │  │
  │         && retries < maxRetries:  │  │ if elapsed <          │  │
  │        hint = parseRetryAfter(    │  │   minIntervalMs:      │  │
  │                 result)            │  │   sleep(diff)         │  │
  │        backoff = retryDelayMs *   │  │ try:                  │  │
  │                  2^(retries-1)    │  │   r = transport       │  │
  │        wait = min(hint+500       │  │       .callTool(...)  │  │
  │                  || backoff,     │  │ catch e:              │  │
  │                  retryCeilingMs) │  │   throw McpToolError  │  │
  │        sleep(wait)                │  │ finally:              │  │
  │        result = liveCall(...)     │  │   lastCallAt = now    │  │
  │        retries += 1               │  └───────────────────────┘  │
  │                                                                │
  │   4) cache write (only on success)                             │
  │      if result.isError != true:                                │
  │        cache.set(cacheKey, { result, expiresAt: now + ttl })   │
  │      return { result, durationMs, fromCache: false }           │
  │                                                                │
  └────────────────────────────────────────────────────────────────┘

  ─── containment boundaries ─────────────────────────────────────
  • rate-limit failures   → contained inside this loop (invisible above)
  • transport errors      → thrown as McpToolError (NOT contained)
  • tool isError (non-RL) → returned as-is (caller decides what to do)
  • timeout (hung call)   → NOT CONTAINED — route's 300s is the only ceiling
```

---

## Implementation in codebase

**Use cases.**
- An agent runs a long investigation that hits a `execute_analytics_eql` call right as another concurrent request bursts on the same user's token. The first call gets a 429; the retry loop parses "1 per 10 second" out of the body and waits ~10.5s; the second attempt succeeds. The agent loop sees only the eventual success.
- The schema bootstrap (`bootstrapSchema` in `lib/mcp/schema.ts:170-192`) makes four sequential tool calls. Without spacing, the second call would 429 immediately. With ~1.1s spacing, all four succeed without ever entering the retry loop.
- A misconfigured `BLOOMREACH_PROJECT_ID` causes `list_projects` to return a real error (not rate-limit). `BloomreachDataSource` does NOT retry — it returns the `isError: true` envelope to `callOrThrow` in `schema.ts:136-149`, which throws `McpToolError` with the server's text attached.
- A `bi:mode=live-synthetic` run dispatches `execute_analytics_eql` to the in-process `SyntheticDataSource`. The call returns synchronously with fixture data — no partial-failure path is exercised. This is by design: the synthetic adapter is for presentation reliability, not for stress-testing the retry loop.

**Code side by side.**

```
  lib/data-source/bloomreach-data-source.ts  (lines 51-55, 64-77, 164-174)

  function isRateLimited(result: unknown): boolean {
    if (!result || typeof result !== 'object' || (result as any).isError !== true)
      return false;                                ← only consider error envelopes
    const text = JSON.stringify((result as any).content ?? result);
    return /rate limit|too many requests/i.test(text);
  }                                                ← regex on the error text;
                                                     no HTTP status to check

  function parseRetryAfterMs(result: unknown): number | null {
    const text = JSON.stringify((result as any)?.content ?? result);
    const after = text.match(/retry[\s-]*after[^0-9]*(\d+)\s*second/i);
    if (after) return parseInt(after[1], 10) * 1000;       ← shape 1
    const perWindow = text.match(/per\s*(\d+)\s*second/i);
    if (perWindow) return parseInt(perWindow[1], 10) * 1000;  ← shape 2
    return null;                                            ← fallback to backoff
  }

  // inside callTool:
  let retries = 0;
  while (isRateLimited(result) && retries < this.maxRetries) {
    retries++;
    const hintMs = parseRetryAfterMs(result);
    const backoffMs = this.retryDelayMs * 2 ** (retries - 1);   ← 10s, 20s, 40s
    const waitMs = Math.min(
      hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,   ← prefer the hint,
      this.retryCeilingMs,                                       cap at ceiling
    );
    await sleep(waitMs);
    result = await this.liveCall(name, args, options.signal);
  }
       │
       └─ the five-part kernel is right here in 11 lines. The bound
          (retries < this.maxRetries) is what makes this terminate;
          remove it and a perpetually-throttling Bloomreach livelocks
          the route until maxDuration kills it.
```

```
  lib/data-source/bloomreach-data-source.ts  (lines 190-205)

  private async liveCall(name, args, signal?): Promise<unknown> {
    const elapsed = Date.now() - this.lastCallAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }                                                ← proactive spacing
    try {
      const result = await this.transport.callTool(name, args, { signal });
      this.lastCallAt = Date.now();                  ← record on success
      return result;
    } catch (err) {
      this.lastCallAt = Date.now();                  ← record on failure too,
      throw new McpToolError(                            so spacing applies to
        name, errorDetail(err), { cause: err }           the next attempt
      );
    }
  }
       │
       └─ STILL no Promise.race on transport.callTool. A hung connection
          would await forever (until the route's 300s killed everything).
          This is the partial-failure gap most worth closing first.
```

```
  lib/mcp/connect.ts  (the BloomreachDataSource construction)

  return {
    ok: true,
    mcp: new BloomreachDataSource(new SdkTransport(client, httpErrors), {
      minIntervalMs: 1100,             ← spacing knob
      retryDelayMs: 10_000,            ← fallback wait base
      retryCeilingMs: 20_000,          ← upper bound on any single sleep
      maxRetries: 3,                   ← total retry budget
    }),
  };
       │
       └─ the four knobs are set HERE for the production transport.
          A different deployment (lower limit, faster window) would
          tune these without touching BloomreachDataSource itself.
          (Note: lib/mcp/client.ts is now a backwards-compat shim that
          re-exports BloomreachDataSource as McpClient — the implementation
          moved during Phase 2 PR A.)
```

---

## Elaborate

The "parse the server's error text" pattern is unusual but not exotic — it's what you do when a server signals its rate-limit state in the response body instead of in a standard HTTP header. Stripe (`X-RateLimit-Limit`/`Reset`), GitHub (`X-RateLimit-Remaining`), and `Retry-After` (RFC 6585) are the standard ways; reading prose out of an error body is what you do when the server doesn't follow any of them. The win is the same: respect the server's stated window, retry past it, give up cleanly.

The right next move for this code, **if scale demanded it**: a circuit breaker that opens after N consecutive rate-limit failures and fails fast for a cooldown period. The current loop spends ~30s on retries every time Bloomreach is overloaded; a circuit breaker would convert that to ~0s during the open period (at the cost of failing requests that might have succeeded). Worth it once you have observability that tells you Bloomreach is degraded; not worth it before.

A per-call timeout (`Promise.race([transport.callTool(), timeout(30_000)])`) is a smaller, more obviously good change. Closes the "hung connection eats the route budget" gap with one wrapper.

---

## Interview defense

**Q: Walk me through what happens when Bloomreach rate-limits one of your tool calls.**

The 429 comes back as HTTP 200 with `isError: true` in the body — that's the MCP JSON-RPC envelope convention. `McpClient.isRateLimited` regexes the body for "rate limit" or "too many requests." If matched, we parse the wait window out of the error text — Bloomreach states it as "Retry after ~N second" or "1 per N second." We sleep that long plus a 500ms cushion, capped at our 20-second ceiling. Then we retry. Bounded by `maxRetries=3`, so worst case we spend ~60 seconds across one tool call before giving up.

```
  the loop: parse → wait → retry → bound

  429 in body  →  parse "N seconds"  →  sleep N+0.5  →  retry
                  (fallback: 2^n backoff)              max 3 times
                  cap at 20s
```

**Q: What's the load-bearing part of that loop people forget?**

The cap on any single sleep. A buggy or hostile server hint of "retry after 600 seconds" would otherwise hang the whole request. `retryCeilingMs=20_000` means no single wait is longer than 20s, even if the parsed hint says otherwise. Same idea as a max-timeout on any individual `setTimeout` — bounds the worst case independently of the bound on retry count.

**Q: What's the gap?**

No per-call timeout on the actual `transport.callTool`. A hung connection (TCP RST not yet received, server processing forever) would await silently until Vercel's `maxDuration` killed the route. A `Promise.race` against a 30s timer would close that gap with maybe 5 lines of code.

```
  what's missing

  transport.callTool(...)   ← no Promise.race with a timer
  if it hangs               → route's 300s is the ONLY ceiling
  fix                       → wrap in timeout(30_000)
```

---

## Validate

- **Reconstruct.** Without looking, write the five-part retry kernel: predicate, bound, wait, ceiling, rebind. Name what breaks if you remove each.
- **Explain.** Why does `parseRetryAfterMs` in `lib/data-source/bloomreach-data-source.ts:64-77` return `null` when no hint is parseable, rather than a default value? Because `null` lets the caller distinguish "no hint, use backoff" from "hint of 0ms" — the explicit null lets the wait calculation pick the right path.
- **Apply.** A new external service you're integrating returns 429 with a `Retry-After` HTTP *header* (not in the body). Sketch the changes. (Add a new `parseRetryAfter` that checks response headers; `isRateLimited` checks status === 429 instead of body regex; rest of the loop is unchanged.)
- **Defend.** Why is `minIntervalMs = 1100` and not, say, `10_000` (matching the observed 10s window)? Because 10s × 6 tool calls = 60s of spacing per investigation, on top of the 300s budget for the actual work, which doesn't fit. 1.1s spacing keeps most first attempts under the window; the retry loop handles the ones that slip through. Trades occasional retry latency for normal-case throughput.

---

## See also

- `01-distributed-system-map.md` — Seam C (Bloomreach) in context
- `03-idempotency-deduplication-and-delivery-semantics.md` — retrying is only safe because every MCP call is a read
- `06-queues-streams-ordering-and-backpressure.md` — the NDJSON stream is what makes the long retry waits tolerable in the UI
- `10-transport-agnostic-protocol-design.md` — RETIRED; history of the two-adapter Phase-2 design
- `.aipe/study-system-design/audit.md#failure-handling-and-reliability` — the failure-handling audit cross-link
- `.aipe/study-networking/` — HTTP-level retry semantics (when generated)

---
Updated: 2026-06-16 — Verdict + structure pass cover the two-adapter shape (Bloomreach retry, Olist per-call timeout); added Part 5b on the Olist partial-failure kernel; line refs migrated from `lib/mcp/client.ts` to `lib/data-source/bloomreach-data-source.ts`; flagged that the per-call-timeout gap is now adapter-asymmetric (closed on Olist, still open on Bloomreach).

---
Updated: 2026-06-19 — Olist adapter deleted (PR #8); Part 5b removed; structure-pass diagram + zoom-out diagram revert to one distributed adapter; the per-call-timeout gap is no longer adapter-asymmetric, just open on Bloomreach (lone finding stands). Verdict rewritten; use-cases swap the Olist case for a SyntheticDataSource note.

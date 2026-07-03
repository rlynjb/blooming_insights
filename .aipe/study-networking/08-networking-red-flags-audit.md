# Networking red flags — audit

*Ranked network-failure risks (Project-specific)* — the protocol and
network-behavior risks grounded in this repo, ranked by consequence.
Every finding is anchored to a `file:line`; the ones that are
`not yet exercised` are named explicitly rather than fabricated.

## Zoom out — where this concept lives

This chapter is the payoff of the previous seven. Each finding names a
specific mechanism the repo relies on, the failure mode it's exposed
to, and the concrete move if it ever bites. Ranked by *consequence
if it fires* — not by likelihood.

```
  Zoom out — the risk topology

  ┌─ Client ─────┐
  │              │  R6: NDJSON parser silent-skip
  │              │  R8: reconnect regex divergence
  └──────┬───────┘
         │
  ┌──────▼──────────────────────────────────────┐
  │ Route                                         │
  │                                                │
  │  R1: retry-ladder budget arithmetic            │
  │  R2: timeouts don't retry but everything else  │
  │  R3: Vercel-instance cache scope               │
  │  R5: no jitter / no circuit breaker            │
  │  R7: fault-injector shape drift                │
  └──────┬────────────────────────────────────┬──┘
         │                                     │
  ┌──────▼──────┐                       ┌──────▼──────┐
  │ Bloomreach  │                       │ Anthropic   │
  │             │  R4: token revocation │             │
  │             │      mid-stream        │             │
  └─────────────┘                       └─────────────┘
```

## The structure pass

The axis: **what's the recovery path from this failure?** Findings
sort by *how much manual attention* is needed if the failure fires.

  - **R1-R2**: silent degradation — user-visible delay, no crash. Recovery
    is time.
  - **R3-R4**: recoverable with app machinery already in place
    (reconnect policy, retry ladder). User sees a hiccup.
  - **R5-R6**: latent bugs that would show up only under specific
    conditions. Silent when not triggered.
  - **R7-R8**: correctness risks in the offline/eval path. Won't hurt
    production directly.

## The findings, ranked

### R1 — Retry-ladder budget arithmetic under a per-call 30s cap

**Severity: high (deliberate; requires Vercel Pro).** **Evidence:**
`lib/mcp/transport.ts:38`, `lib/data-source/bloomreach-data-source.ts:135-136,163-174`.

The retry ladder can wait up to `retryCeilingMs = 20_000` × `maxRetries = 3`
= 60 seconds of wall clock on a single rate-limited call. On Vercel Pro
(300s route budget) this is fine — even a worst-case call takes ~65s and
you have room for several more. On Vercel Hobby (60s ceiling), a single
rate-limited call would consume the entire budget.

```
  Worst-case wall clock: one rate-limited call

  attempt 1: server responds fast, "1 per 10 second"
    wait: min(10_500, 20_000) = 10.5s
  attempt 2: still rate-limited
    wait: min(10_500 OR 20_000, 20_000) = ~10.5-20s
  attempt 3: still rate-limited
    wait: same
  attempt 4: give up (maxRetries = 3)

  total: ~31s of retry waits + 4 × ~200ms fast responses ≈ 32s
```

**What's the move?** The `maxDuration = 300` on both routes (`briefing/route.ts:19`,
`agent/route.ts:22`) is the guard. If the app ever moves to a plan
with a smaller budget, `maxRetries` needs to drop to 1 or the ceiling
needs to shrink.

### R2 — Timeouts fail fast; only rate-limit *results* retry

**Severity: medium (deliberate design choice; documented).** **Evidence:**
`lib/mcp/transport.ts:44-48, 135-137`,
`lib/data-source/bloomreach-data-source.ts:51-55, 164`.

A stuck upstream (network partition, unresponsive server) takes exactly
30s of `AbortSignal.timeout` and then throws `HTTP 0: timeout after 30000ms`.
No retry. The retry ladder only fires on tool *results* whose
`isError === true` text matches `/rate limit|too many requests/i`.

This is the *right* call for a route with a fixed budget — retrying a
timeout wastes another 30s learning nothing new. But it does mean that
transient network blips lose the call entirely instead of retrying at
a lower level. On Bloomreach specifically, transient blips are rare
(the alpha server's failure modes are rate-limits and token revocation,
not network flake), so the tradeoff holds.

**What's the move?** No change needed for current traffic. If observed
transient-error rate ever grew, add a small retry-on-timeout (1 attempt,
short backoff) — but only after measuring.

### R3 — 60s response cache is per-Vercel-instance

**Severity: medium (functional degradation, not incorrect behavior).**
**Evidence:** `lib/data-source/bloomreach-data-source.ts:122, 186`.

The 60s response cache is a `Map<string, {result, expiresAt}>` on the
`BloomreachDataSource` instance. Each Node instance on Vercel has its
own; a briefing that runs across two instances (unlikely but possible)
would hit the cache twice, once per instance. The retry ladder handles
this fine — worst case is 2× cost on that briefing.

Also: on production the `BloomreachDataSource` is constructed inside
each request via `makeDataSource → connectMcp`, so the cache is *also*
per-request. The comment at `lib/data-source/index.ts:63-65` documents:

> Returns the already-connected BloomreachDataSource as a `DataSource`,
> with a `dispose` no-op (the Bloomreach client outlives the request
> via the cookie-scoped auth store — disposing here would not undo the
> OAuth state).

But the *client instance* is fresh per request; the cache is fresh
per request. The 60s TTL only helps for repeated identical calls *inside
one briefing* — which is exactly its intended use.

**What's the move?** None. This is the pragmatic scope. Cross-request
sharing would need a shared store (Redis/KV) which the app doesn't have
and doesn't currently need.

### R4 — Token revocation depends on the reconnect regex matching

**Severity: medium (user-visible on regex miss; documented latent bug).**
**Evidence:** `lib/hooks/useReconnectPolicy.ts:33-45`,
`lib/mcp/transport.ts:139-142` (surfaces the raw server body).

The alpha Bloomreach server revokes OAuth tokens after minutes. The
route catches the resulting HTTP 401 and emits `{type:'error',
message: 'HTTP 401: … invalid_token …'}` as an NDJSON event. The
client's reconnect policy uses two regex variants to match:

```ts
  const AUTH_ERROR_RE_AUTO   = /invalid_token|unauthor|forbidden|401|session expired|reconnect/i;
  const AUTH_ERROR_RE_BUTTON = /unauthor|forbidden|401|session expired/i;
```

The comment at `useReconnectPolicy.ts:21-30` explicitly flags:

> There IS a latent bug worth flagging (the button regex is missing
> `invalid_token` and `reconnect` matches) — filed as a future concern;
> not this refactor's job.

**Concrete consequence**: if the token revocation manifests as *only*
`invalid_token` in the error text (no `401`, no `unauthor…`), the
manual reconnect button won't recognize it and the user can't recover
without a full page reload.

**What's the move?** Unify the two regexes to the LONG variant after
verifying against the live server. Ticket exists per the comment.

### R5 — No jitter, no circuit breaker

**Severity: low (not exercised at current scale).** **Evidence:**
absence — grep `jitter|circuit` returns zero hits in `lib/`.

Two production-grade features the app deliberately doesn't have:

  - **Jitter on retries** — the retry ladder is deterministic. Fine at
    one user. At N concurrent users hitting the same 1-per-10s
    window, all N would retry at roughly the same wall-clock instant,
    guaranteeing a second 429.
  - **Circuit breaker** — after N consecutive timeouts on the same
    origin, a circuit breaker would fail fast for a cool-down period
    instead of absorbing 30s on every call. Not exercised.

**What's the move?** Nothing for now. If the app ever fanned out to
multiple concurrent users per Node instance, add ±1s jitter to
retries (one line) and a simple last-N-failures circuit breaker
(~10 lines).

### R6 — NDJSON parser silently skips malformed lines

**Severity: low (design choice; testable via `onMalformed`).**
**Evidence:** `lib/streaming/ndjson.ts:42-49`.

```ts
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      onEvent(JSON.parse(line) as E);
    } catch (err) {
      opts?.onMalformed?.(line, err);   // silent by default
    }
  }
```

If a producer emits garbage between valid events, the parser drops it.
This is defensible — it's the same shape the fault-injecting
`malformed_json` mode tests (`fault-injecting.ts:139-154`) — but it
does mean a truly broken producer would appear to be working from the
client's perspective while silently skipping data.

**What's the move?** No change. The `onMalformed` hook is available
if a consumer needs to alert on it (currently no client passes it).

### R7 — Fault injector shape drift

**Severity: low (offline path only).** **Evidence:**
`lib/data-source/fault-injecting.ts:112-137` — comments explicitly
call out that the shapes match specific `lib/mcp/transport.ts` lines
and `BloomreachDataSource` retry triggers.

The `FaultInjectingDataSource` mimics real error shapes:
  - `HTTP 0: timeout after 30000ms` (matches `transport.ts:137`)
  - 429 with `Rate limited: please retry after 2000ms` (matches
    `BloomreachDataSource` retry trigger)
  - `HTTP 500: Internal server error`
  - malformed body (unclosed JSON in text block)

The shapes are hand-maintained. If the real transport ever changes its
error format (`HTTP 0:` → `TIMEOUT:` say), the fault injector's
regression tests would keep passing but production wouldn't recover
the same way.

**What's the move?** Add a test that asserts both paths emit the same
error string. Currently the two files reference each other in
comments but the invariant isn't automated.

### R8 — Vercel edge caching is opted out with `no-store`, but only on the streams

**Severity: low (correctness on route-level only).** **Evidence:**
`app/api/briefing/route.ts:149, 333`, `app/api/agent/route.ts:107`.

The three streaming routes emit `Cache-Control: no-store, no-transform`.
The other MCP routes (`/api/mcp/{call,tools,tools/check,reset,capture,capture-demo,callback}`)
don't set explicit cache headers. Vercel defaults for API routes are
"no cache" — but relying on defaults rather than being explicit is a
small documentation risk.

**Concrete consequence**: if Vercel ever changed its API-route caching
default, or if a self-hosted deployment landed behind a different edge,
the mutation routes (`/api/mcp/reset`, `/api/mcp/callback`) might cache
briefly. `/api/mcp/callback` is a one-shot; caching it would be a
security issue.

**What's the move?** Add explicit `Cache-Control: no-store` to
`/api/mcp/callback` at minimum, and to the other MCP routes as
defense in depth.

## Ranked summary

```
  Findings ranked by consequence

  ┌─────────────────────────────────────────┬──────────┬──────────────────┐
  │ finding                                  │ severity │ status           │
  ├─────────────────────────────────────────┼──────────┼──────────────────┤
  │ R1 retry-ladder budget arithmetic        │ high     │ deliberate,      │
  │                                          │          │ requires Pro     │
  │ R2 timeouts fail fast                    │ medium   │ deliberate       │
  │ R3 60s cache per Node instance           │ medium   │ pragmatic scope  │
  │ R4 reconnect regex divergence            │ medium   │ documented bug   │
  │ R5 no jitter / no circuit breaker        │ low      │ not exercised    │
  │ R6 NDJSON silent-skip on malformed       │ low      │ intentional      │
  │ R7 fault-injector shape drift            │ low      │ hand-maintained  │
  │ R8 MCP route cache headers not explicit  │ low      │ Vercel defaults  │
  └─────────────────────────────────────────┴──────────┴──────────────────┘
```

## Not yet exercised — flagged explicitly

These wire behaviors don't exist in the repo. Flagged so a reader
knows the absence is real, not an omission of this audit:

  - **DNS pinning** — no cached A-record; no fallback resolver.
  - **HTTP/2 tuning** — the app doesn't override the platform default.
    Undici negotiates HTTP/2 via ALPN if the upstream supports it, but
    stream concurrency, flow control, and PING keepalive are
    platform-defaulted.
  - **HTTP/3 / QUIC** — not exercised.
  - **mTLS** — no client certs; bearer tokens throughout.
  - **Certificate pinning** — system CA store trusted end-to-end.
  - **WebSockets** — not exercised anywhere (see 06 for the deliberate
    choice).
  - **Server-Sent Events** — considered and rejected (see 06).
  - **CORS** — same-origin only.
  - **Request coalescing / singleflight** — no dedupe of concurrent
    identical in-flight requests. The 60s cache handles serial repeats;
    concurrent duplicates would race.
  - **Jitter on retries** — deterministic wait (see R5).
  - **Circuit breaker** — no state kept across failures (see R5).
  - **Connection pool tuning** — Undici defaults trusted.
  - **Keepalive interval tuning** — no `Keep-Alive: timeout=N` header set
    on responses; the app relies on the platform's default idle timeout.
  - **Trailers** — no HTTP trailers used; final state travels in the
    body as the `{type:'done'}` NDJSON event instead.

## Cross-links

  - **Trust boundaries at each hop** (whether encryption/auth is safe) —
    see `.aipe/study-security/`.
  - **Which network boundaries belong at the architecture level** —
    see `.aipe/study-system-design/`.
  - **The performance cost of these tradeoffs** —
    see `.aipe/study-performance-engineering/`.
  - **How the AbortSignal composition maps to runtime cancellation** —
    see `.aipe/study-runtime-systems/`.
  - **The observability of these failures on production** —
    see `.aipe/study-debugging-observability/` (per-phase timings
    logged at `briefing/route.ts:315-324` and `agent/route.ts:329-338`).

# Networking red-flags audit

**Ranked risks across the three wire surfaces** · Project-specific

## Zoom out — where this concept lives

The closing file. Every observation in 01-07 produces either a green check or a flag; this file collects the flags, ranks them by consequence, and names the evidence and the move.

```
  Zoom out — what this file audits

  ┌─ UI band ──────────────┐  ★ regex split flag #2 ★
  └────────────────────────┘
            │
  ┌─ Service band ─────────┐  ★ spacing-during-cancel gap flag #6 ★
  │                        │  ★ no heartbeat on long stream flag #4 ★
  │                        │  ★ no client-side request timeout flag #5 ★
  │                        │  ★ cache-control header drift flag #7 ★
  └────────────────────────┘
            │
  ┌─ Provider band ────────┐  (we don't own; ranked by what hits us)
  └────────────────────────┘  ★ alpha server token revocation flag #1 ★
                              ★ rate limit window stated in error text flag #3 ★
```

## Zoom in — the concept

A ranked list. Each flag carries: severity, evidence (file:line), what breaks if ignored, the move.

Severity legend:

- **CRITICAL** — known to cause user-visible failure today, or one config change away from doing so.
- **HIGH** — degrades the UX or burns budget under common conditions.
- **MEDIUM** — latent or only matters at scale we don't yet hit.
- **LOW** — code quality / consistency, no user impact.

## Structure pass

### Axes used to rank

- **Probability of hit** — how often does the failure mode fire?
- **Blast radius** — does it affect one call, one user, or everyone?
- **Recovery cost** — auto-heals, or requires manual intervention?

A CRITICAL flag is high on all three. A LOW flag is low on at least two.

### Skeleton parts

Each flag below has the same shape:

```
  flag #N — <name>                            severity: <CRITICAL|HIGH|MEDIUM|LOW>
  ─────────────────────────────────────────────
  evidence:    <file:line(s)>
  what breaks: <one paragraph>
  the move:    <one paragraph>
```

## How it works — walk the flags

### Flag #1 — Bloomreach alpha server revokes tokens after minutes
**Severity: HIGH** (every live session hits this; mitigation exists; user briefly sees a reload)

```
  evidence:    documented in lib/mcp/connect.ts:86-93 (the proactive-spacing rationale)
               and lib/hooks/useReconnectPolicy.ts:9-11 (policy comment)
  what breaks: mid-briefing 401 with `invalid_token` body. The NDJSON stream emits
               {type:"error", message:"… invalid_token …"}. Without the reconnect
               policy, the user sees the error and has to click reconnect manually.
  the move:    useReconnectPolicy auto-reset+reload on the first invalid_token error
               per session — already in place, working. Anchor: useReconnectPolicy.ts:84-111.
               One-shot guard prevents looping if re-auth also fails.
```

The mitigation is real and shipping. Listed CRITICAL/HIGH because if `useReconnectPolicy` ever stopped firing on an `invalid_token` (e.g. message text changes), every live briefing past minute 3 would 401 and stick. The auto-reconnect is what makes live mode usable.

### Flag #2 — Two divergent auth-error regexes
**Severity: MEDIUM** (the explicit reconnect button can miss `invalid_token`; the auto path catches the common case)

```
  evidence:    lib/hooks/useReconnectPolicy.ts:33-34

    const AUTH_ERROR_RE_AUTO   = /invalid_token|unauthor|forbidden|401|session expired|reconnect/i;
    const AUTH_ERROR_RE_BUTTON = /unauthor|forbidden|401|session expired/i;

  what breaks: AUTH_ERROR_RE_BUTTON is missing `invalid_token` and `reconnect`.
               If the auto-reconnect already fired (one-shot guard set) and the
               user is shown the error UI, an `invalid_token` error won't trigger
               the manual "reconnect" button to render. The user sees the error
               but no clear recovery path.
  the move:    Unify to AUTH_ERROR_RE_AUTO. The hook's own comment flags this and
               punts on it: "Unifying them would require manual verification against
               the live Bloomreach server, which is not available in the current
               session" (useReconnectPolicy.ts:19-22). One-line fix; the gating is
               operational, not technical.
```

The code itself names this. That's the highest signal that the flag is real.

### Flag #3 — Rate-limit hint parsing depends on error text format
**Severity: MEDIUM** (works today against observed shapes; would silently degrade if Bloomreach changes the message)

```
  evidence:    lib/data-source/bloomreach-data-source.ts:64-71

    function parseRetryAfterMs(result: unknown): number | null {
      const text = JSON.stringify((result as any)?.content ?? result);
      const after = text.match(/retry[\s-]*after[^0-9]*(\d+)\s*second/i);
      if (after) return parseInt(after[1], 10) * 1000;
      const perWindow = text.match(/per\s*(\d+)\s*second/i);
      if (perWindow) return parseInt(perWindow[1], 10) * 1000;
      return null;
    }

  what breaks: Two regex shapes handle the two observed wordings. If Bloomreach
               changes the format ("Wait 15s before retrying", "rate-limited:
               15000ms"), parseRetryAfterMs returns null, the ladder falls back
               to exponential backoff off retryDelayMs=10_000 capped at
               retryCeilingMs=20_000. The retries still happen; they just don't
               honor a precise hint. Degraded, not broken.
  the move:    Prefer a structured `Retry-After` HTTP header if Bloomreach starts
               sending one. Until then, the fallback is honest — backoff is at
               least as long as the observed 10s penalty window. Worth a log entry
               when the parser returns null, so we notice format drift early
               (currently silent — the only signal is "retries fire but feel slow").
```

### Flag #4 — No heartbeat on long-lived NDJSON stream
**Severity: MEDIUM** (not observed in prod; intermediate proxy idle timeouts could close mid-stream during a long Bloomreach retry)

```
  evidence:    app/api/briefing/route.ts (no setInterval emitting a heartbeat event);
               lib/streaming/ndjson.ts (no heartbeat handling on the consumer side)

  what breaks: If a single MCP call hits 3 retries × 20s = 60s of waits with no
               events fired to the client, intermediate proxies (Vercel edge,
               corporate firewalls, browser network stacks) can close the idle
               connection. The browser sees a stream-close that looks like a
               natural "done" but actually missed the final events.
  the move:    Add a {type:"heartbeat"} event every 10s during long waits. One
               setInterval inside the stream `start` callback. The NDJSON kernel
               already silently skips unknown event types because the consumers'
               switch statements have default branches — so adding a new type is
               backwards-compatible. Not a hot bug; do this when the retry ladder
               gets exercised under load.
```

### Flag #5 — No client-side request timeout on fetch
**Severity: MEDIUM** (a stalled response would hang the hook indefinitely)

```
  evidence:    lib/hooks/useBriefingStream.ts:158 (`const res = await fetch(url)`)
               — no AbortController.timeout(...) wrapping the fetch.
               Same shape in lib/hooks/useInvestigation.ts and StreamingResponse.tsx.

  what breaks: If a Vercel function takes forever to send the FIRST byte (TCP
               connected, TLS handshook, no response), the browser waits with
               default fetch timeout — which is platform-defined and usually
               long. The user sees an indefinite loading state. The hook's only
               cleanup path is the unmount/cancel flag, which depends on the
               component being unmounted.
  the move:    Add an AbortController with a 60s timeout for the initial response,
               and rely on the per-event timing for the streaming phase. Or wire
               a "no events in 30s" watchdog that aborts the controller. Either
               way, the goal is a fast-fail signal for "the server isn't even
               sending headers." Lower priority because Vercel's own function
               timeout (300s) is the ultimate ceiling; user just sees a long wait.
```

### Flag #6 — Proactive spacing sleep isn't AbortSignal-aware
**Severity: LOW** (worst case 1.1s of "the cancel didn't land yet" — invisible to users)

```
  evidence:    lib/data-source/bloomreach-data-source.ts:191-193

    const elapsed = Date.now() - this.lastCallAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }

  what breaks: If the route is aborted DURING this spacing wait (user closed tab
               at exactly the wrong moment), the sleep runs to completion before
               the call attempt detects the abort. The user is gone; we wait an
               extra ~1.1s before the chain finishes unwinding.
  the move:    Race the sleep against `signal.addEventListener('abort', …)` or
               use a signal-aware sleep helper. Trivial to add; not worth doing
               until something else surfaces the gap.
```

### Flag #7 — Cache-control header inconsistency between routes
**Severity: LOW** (no behavioral difference today; future cleanup)

```
  evidence:    app/api/briefing/route.ts:333  → 'cache-control': 'no-store, no-transform'
               app/api/agent/route.ts:107     → 'Cache-Control': 'no-cache, no-transform'

  what breaks: `no-store` and `no-cache` differ in semantics — no-store means
               "don't keep a copy at all," no-cache means "keep a copy but
               revalidate every time." For our setup (no CDN in front of /api/*,
               no browser benefit from caching streams), both behave identically.
               The drift is purely cosmetic — until someone puts a cache in front
               and now half the routes are cached and half aren't.
  the move:    Pick one (no-store is stricter, safer default) and apply across
               every streaming route. Five-character edit, not urgent.
```

### Flag #8 — No CORS / OPTIONS handling
**Severity: NOT A FLAG — listed for completeness**

```
  evidence:    no Access-Control-* headers anywhere; no OPTIONS handlers
  what breaks: nothing today — every browser-originated request is same-origin.
               Cross-origin calls happen server-side where CORS doesn't apply.
  the move:    if /api/* is ever exposed to an embedded SPA on another origin,
               add the appropriate Access-Control-Allow-* headers. Until then, the
               absence is correct. See 05-http-semantics-caching-and-cors.md for
               the full mechanical explanation.
```

### `not yet exercised` — concepts whose risk we can't audit because the mechanism is absent

```
  ─ UDP at the application layer — no risk because no code
  ─ WebSocket upgrade — no risk because no upgrade is attempted
  ─ SSE / EventSource — no risk because we don't use it
  ─ Connection pool tuning at the app layer — relies on undici defaults; not
    a flag yet because no failure has been observed; would become a flag if we
    saw `socket hang up` errors clustering under load
  ─ Multi-region failover — no risk because there's nothing to fail over
  ─ Backpressure on the NDJSON producer — using push-based ReadableStream; would
    matter if event volume grew to thousands per stream
```

## Primary diagram

```
  the recap — flags ranked by severity

  ┌─ CRITICAL ──────────────────────────────────────────────────────┐
  │  (none today — flag #1 ranked HIGH because mitigation works)    │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ HIGH ──────────────────────────────────────────────────────────┐
  │  #1  Token revocation every few minutes                          │
  │      → mitigated by useReconnectPolicy auto-reload               │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ MEDIUM ────────────────────────────────────────────────────────┐
  │  #2  Two divergent auth-error regexes                            │
  │      → button regex missing `invalid_token`                      │
  │  #3  Rate-limit hint parsing depends on text format              │
  │      → fallback to backoff works; loses precision                │
  │  #4  No heartbeat on long-lived NDJSON stream                    │
  │      → intermediate proxies could close idle connection          │
  │  #5  No client-side fetch timeout                                │
  │      → indefinite hang if server never sends first byte          │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ LOW ───────────────────────────────────────────────────────────┐
  │  #6  Spacing sleep not AbortSignal-aware (1.1s gap)              │
  │  #7  cache-control header drift (no-store vs no-cache)           │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ NOT A FLAG ────────────────────────────────────────────────────┐
  │  #8  No CORS — correct because all browser fetch is same-origin  │
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

If you're reading this list to decide what to fix next, the priority order is:

1. **Verify flag #1's mitigation still fires under current Bloomreach text.** This is the only flag that *every* live user hits. Even a passive check — "log a counter whenever `useReconnectPolicy.handle` returns true" — would tell us if a Bloomreach error-message change broke recovery.

2. **Fix flag #2 (regex unification).** One-line fix gated only by manual verification. Bundle it with #1's verification and you do both in one session.

3. **Add flag #5 (client-side fetch timeout).** Lower frequency than #1 but worse UX when it fires — the user has no signal that the request died. A 60s response-headers timeout is a few lines.

4. **Address flag #4 (heartbeat) only if you see retry waits getting long.** Until then, the absence is acceptable.

5. **Flags #3, #6, #7 can wait.** None affect users today.

The flags this audit *didn't* find are also load-bearing. There's no CRITICAL today. The boring choice — NDJSON over chunked HTTP, undici keepalive pooling, AbortSignal composition, the per-call 30s timeout — held up. The system has real failure modes, but the failure modes have real mitigations in place. The remaining gaps are *known, named, and bounded*.

## Interview defense

**Q: What's the biggest networking risk in this app?**

> The two-regex split in `useReconnectPolicy`. `AUTH_ERROR_RE_BUTTON` is missing `invalid_token` and `reconnect` — both present in `AUTH_ERROR_RE_AUTO`. Effect: the explicit "reconnect" button might not render for an `invalid_token` error specifically. The auto-reconnect path catches the common case, so most users never notice; but if the auto path's one-shot guard already fired, the user is stuck looking at an error with no recovery button. Latent, low blast radius. The code's own comment flags it. One-line fix, gated on manual verification against live Bloomreach.

```
  on the whiteboard:

  AUTH_ERROR_RE_AUTO   = invalid_token | unauthor | forbidden | 401 | session expired | reconnect
  AUTH_ERROR_RE_BUTTON =                  unauthor | forbidden | 401 | session expired
                          ▲                                                              ▲
                          missing here                                       missing here
```

Anchor: the latent bug the code itself names.

**Q: Why isn't there a CRITICAL flag?**

> Because every known failure mode has a mitigation in place. Token revocation has auto-reconnect. Rate limits have proactive spacing + retry ladder + 60s cache. Hung calls have the per-call 30s timeout. The retry-ladder ceiling caps damage to 20% of the route budget. The remaining flags are degradation modes (no precision on retry hints, no heartbeat for very long waits) and code-quality cleanup (regex unification, header drift). Nothing currently breaks for users under expected conditions.

Anchor: defensive primitives compose, no single layer carries the load.

**Q: If you had one engineering day to spend on this list, what would you do?**

> Three changes, in this order. One, log a counter when `useReconnectPolicy.handle` returns true — that gives us a "is auto-reconnect still working" signal in production. Two, unify the two auth-error regexes (flag #2) and verify against live Bloomreach. Three, add a 60s response-headers AbortController.timeout to the three `fetch` calls in `useBriefingStream`, `useInvestigation`, and `StreamingResponse` (flag #5). All three changes are <50 LOC together, all three reduce real risk, and the order is "measure → fix the known → close the unknown."

Anchor: instrument first, fix second, harden third.

## See also

- `01-network-map.md` — where each flagged surface sits
- `06-websockets-sse-streaming-and-realtime.md` — flag #4's home
- `07-timeouts-retries-pooling-and-backpressure.md` — flags #1, #3, #5, #6's home
- `study-security/audit.md` — the trust-boundary side of flags #1 and #2

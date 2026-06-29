# 08 · Networking red flags — audit

## Subtitle

Ranked protocol and network-failure risks, grounded in the repo — Project-specific.

## Zoom out, then zoom in

A ranked audit of where the network surface in this repo is most likely to bite, ordered by consequence. The top items are real failure modes a user can hit today; lower items are smaller-blast-radius issues or future concerns the architecture doesn't yet need to solve. Each one names the file, the failure mode, and the fix (or the deliberate non-fix).

```
  Zoom out — what each finding maps to

  ┌─ UI layer ──────────────────────────────────────────────────┐
  │  R6: client fetches have no timeout                          │
  │  R7: no backpressure check on the read loop                  │
  └────────────────────────────────────────────────────────────┘
                            │
                            ▼
  ┌─ Service layer ─────────────────────────────────────────────┐
  │  R1: rate-limit retry math can overshoot Hobby's 60s budget  │
  │  R2: regex-based rate-limit window parsing is fragile         │
  │  R3: per-request MCP connect — no socket reuse across calls │
  │  R4: no controller.desiredSize backpressure                  │
  │  R5: cookie size cap could bite if state grows               │
  │  R8: state validation deliberately disabled (verified note)  │
  └────────────────────────────────────────────────────────────┘
                            │
                            ▼
  ┌─ Provider boundary ────────────────────────────────────────┐
  │  R9: alpha Bloomreach endpoint may rotate without notice    │
  │  R10: anthropic SDK retries opaque to app code              │
  └────────────────────────────────────────────────────────────┘
```

## Ranking

  - **R1** — rate-limit retry math can exceed Hobby's budget · medium consequence · easy fix on Pro (already on Pro; documented constraint).
  - **R2** — regex-based rate-limit window parsing is fragile to envelope wording changes · medium consequence · falls back to backoff gracefully.
  - **R3** — per-request MCP connect means TCP/TLS handshake per route invocation · low consequence today · scales-poorly later.
  - **R4** — `controller.enqueue` doesn't check `desiredSize`; runtime buffers · low consequence at current volumes.
  - **R5** — encrypted cookie holds OAuth state; 4KB browser cap is comfortable but not infinite · low consequence; future concern.
  - **R6** — client-side `fetch(url)` has no AbortSignal; if route hangs past 300s the browser hangs forever · low consequence (route guarantees close).
  - **R7** — `readNdjson` has no flow-control; reads as fast as bytes arrive · trivial at current volumes.
  - **R8** — OAuth `state` validation deliberately off (SDK validates internally) · zero consequence today; flagged for awareness.
  - **R9** — alpha Bloomreach endpoint may rotate · low consequence; env var swap.
  - **R10** — Anthropic SDK's internal retry behavior is opaque to app code · low consequence; provider-managed.

## How it works (each finding)

### R1 · Rate-limit retry math vs route budget

**Where:** `lib/data-source/bloomreach-data-source.ts:163-174`.

**The failure mode:**

```
  Worst-case single call under rate-limit, on Pro (300s budget):

  call 1:    1.1s spacing + 0.5s exec     → 1.6s
             rate-limited
             retry 1: 10s + 0.5s cushion  → 10.5s wait
  call 2:    1.1s spacing + 0.5s exec     → 1.6s
             rate-limited
             retry 2: 20s (ceiling)       → 20s wait
  call 3:    1.1s spacing + 0.5s exec     → 1.6s
             rate-limited
             retry 3: 20s (ceiling)       → 20s wait
  call 4:    1.1s spacing + 0.5s exec     → 1.6s
             rate-limited
             retries exhausted → throw     → caller sees the error

  total on this one tool call: ~57s
```

On Vercel Pro's 300s budget, that's ~19% of the request. Manageable for one bad call. On Hobby's 60s budget, that one call alone would blow the budget. The repo deliberately requires Pro:

```ts
// app/api/briefing/route.ts:19 (and agent/route.ts:22)
// 300s = Vercel Pro's max. The monitoring agent + ~1 req/s MCP spacing can run
// well past Hobby's 60s ceiling, so the live briefing needs the higher budget.
export const maxDuration = 300;
```

**Severity:** medium · documented constraint, deployment-platform aware.

**Fix:** stay on Pro. If a future deployment target capped at 60s, the choices are (a) lower `maxRetries` to 1, (b) lower `retryCeilingMs` from 20s to something like 5s, or (c) move expensive calls to a background job pattern. None of these are needed today.

### R2 · Regex-based rate-limit window parsing

**Where:** `lib/data-source/bloomreach-data-source.ts:64-71`.

**The failure mode:** `parseRetryAfterMs` matches two known shapes:

```ts
//   "Retry after ~12 second(s)"            → 12_000
//   "rate limit reached (1 per 10 second)" → 10_000
```

If Bloomreach changes the wording — `"please wait 10 seconds before retrying"`, `"rate-limit window: 10s"`, anything not matching the two regexes — the parse returns `null` and the caller falls back to exponential backoff. The backoff math (10s, 20s, 20s) is still safe but may overshoot or undershoot the real window. In the worst case it triggers another rate-limit immediately by retrying inside the same penalty window.

**Severity:** medium · graceful degradation (falls back to backoff), but the safe fallback is also the slower one.

**Fix:** when (if) Bloomreach exposes a structured `retry-after` field or header, swap the regex for the structured read. Today the envelope is text-only so the regex is the only option.

### R3 · Per-request MCP connect

**Where:** `lib/data-source/index.ts:85` (calls `connectMcp(sessionId)` on every request).

**The failure mode:** each route invocation runs:

  1. `connectMcp` → `withAuthCookies` → decrypt cookie → instantiate `BloomreachAuthProvider`.
  2. `new StreamableHTTPClientTransport(...)`.
  3. `client.connect(transport)` → TLS handshake to loomi-mcp-alpha.bloomreach.com.

Step 3 is a fresh TCP/TLS handshake every time. At a typical ~50-150ms for a TLS 1.3 handshake to a warm Bloomreach edge, that's the floor on every request. The OAuth tokens *persist* across requests (via the cookie store), but the socket doesn't.

**Severity:** low today · scales poorly later.

**Fix:** pool MCP `Client` instances across requests, keyed by session. The architectural seam is already drawn — `makeDataSource` is the construction point; a process-level `Map<sessionId, BloomreachDataSource>` with a TTL would intercept. The cost is correctness around OAuth-token refresh (the pooled client needs to honor token updates) and against Vercel's ephemeral runtime (a pool on one instance doesn't help requests routed to another). For the current single-user volume, the handshake cost is in the noise.

### R4 · No backpressure on the writer

**Where:** `app/api/briefing/route.ts:193`, `app/api/agent/route.ts:189`.

**The failure mode:**

```ts
const send = (e: BriefingEvent) =>
  controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
```

Synchronous enqueue, no `controller.desiredSize` check, no await. If the browser's read is slow (slow client device, slow network), the runtime buffers in memory. At this app's volumes (~30 events per stream, each truncated to 4KB by `trunc(v)` at `app/api/briefing/route.ts:71-75`), the total in-flight bytes are bounded under 120KB — trivial.

The risk scenario is "thousands of events per stream to a slow reader" — not today's profile. If it became one, the writer would grow unbounded buffers in Vercel's edge or in Node's stream layer.

**Severity:** low · current volumes are nowhere near the buffer ceiling.

**Fix:** if event volume per stream grows, change `send` to `await controller.desiredSize < 0 ? new Promise(...)` style flow-control. The shape change is mechanical; trigger condition isn't here yet.

### R5 · Cookie size cap

**Where:** `lib/mcp/auth.ts:48` (`bi_auth` cookie).

**The failure mode:** browsers cap one cookie at ~4KB. The encrypted blob holds:

  - 12-byte IV + 16-byte GCM tag = 28 bytes overhead
  - Encrypted JSON of: `clientInformation` (~500 bytes), `codeVerifier` (~128 bytes), `tokens` (access_token + refresh_token + id_token, ~1500-2000 bytes), `state` (~36 bytes if present)
  - All base64url-encoded (adds ~33%)

Total: typically ~3KB. Comfortable margin. If a future expansion adds more state per session — multiple OAuth providers, a session-tied audit log, per-flow PKCE history — the margin shrinks fast.

**Severity:** low · future concern.

**Fix:** if cookie size becomes a constraint, move state to Redis/Vercel KV. The seam is `withAuthCookies`; a different backend implementation is a one-file swap.

### R6 · No client-side fetch timeout

**Where:** `lib/hooks/useBriefingStream.ts:158`, `lib/hooks/useInvestigation.ts:180`, `components/chat/StreamingResponse.tsx:92`.

**The failure mode:**

```ts
const res = await fetch(url);    // no { signal }, no timeout
```

If the route hangs past 300s (Vercel will terminate it then), the browser sits on `await fetch(url)` until the TCP connection actually closes. In practice this is fine because Vercel reliably closes the connection on `maxDuration`, but the app code doesn't have a backstop.

**Severity:** low · relies on Vercel's termination guarantee.

**Fix:** add `AbortController` + `setTimeout(controller.abort, ROUTE_BUDGET + 30_000)` per fetch, compose with the existing `cancelOn` ref. The shape change is one helper function; the risk it covers is small.

### R7 · `readNdjson` has no flow-control

**Where:** `lib/streaming/ndjson.ts:17-64`.

**The failure mode:** the kernel reads as fast as bytes arrive. There's no consumer-side rate limit, no per-event acknowledgment, no pause-when-busy. If a future producer ships thousands of small events per second and each `onEvent(...)` triggers expensive `setState` work, the read loop dominates the main thread.

**Severity:** trivial at current volumes (~30 events per stream).

**Fix:** add an `onEvent` boundary that batches via `queueMicrotask` or `requestAnimationFrame` for UI-bound work. Not needed today.

### R8 · OAuth `state` validation disabled

**Where:** `app/api/mcp/callback/route.ts:22-26`, `lib/mcp/auth.ts:230` (`consumeState`).

**The current state:** the callback does NOT re-validate the `state` parameter; the SDK validates it internally.

```ts
// NOTE: we do NOT re-validate the OAuth `state` here. The MCP SDK invokes the
// provider's state() more than once during a single auth() flow, so our naive
// "store-last, compare-on-callback" check rejected legitimate callbacks
// ("state mismatch"). The SDK performs its own state handling; re-validating
// at this layer is redundant. (Verified live 2026-05-27.)
```

The `consumeState` helper is kept (and tested) for a future shared-store implementation.

**Severity:** zero today (SDK handles it) · flagged for awareness only.

**Fix:** none needed. If the SDK's behavior ever changes (state validation becomes the integrator's job), the helper is ready.

### R9 · Alpha endpoint may rotate

**Where:** `lib/mcp/connect.ts:30-34`.

```ts
function mcpUrl(): URL {
  const raw =
    process.env.BLOOMREACH_MCP_URL ?? 'https://loomi-mcp-alpha.bloomreach.com/mcp/';
```

**The failure mode:** the default points at an *alpha*-band hostname. Alpha environments rotate, get retired, or change auth requirements without LTS-style notice. If the hostname goes away without a env-var swap, the app breaks for everyone on the default.

**Severity:** low · one env-var change to fix.

**Fix:** when Bloomreach ships GA, update the default. Until then, document the env-var override prominently in deployment notes (`BLOOMREACH_MCP_URL`).

### R10 · Anthropic SDK retry behavior is opaque

**Where:** `@anthropic-ai/sdk` calls in `lib/agents/base.ts` (`runAgentLoop` calls `anthropic.messages.stream({...})`).

**The failure mode:** the SDK has its own retry behavior (configurable, but the app doesn't configure it). If Anthropic returns a 429, the SDK may retry silently; if it returns a 500, the SDK may retry silently. The app sees only the final outcome (success or final failure). The per-phase wall-clock log (`phases` in `route.ts`) shows total time including hidden retries, but doesn't break them down.

**Severity:** low · provider-managed; rare in practice.

**Fix:** if more visibility is needed, pass an explicit `maxRetries: 0` in the Anthropic constructor and own the retry loop, or pass a custom `fetch` to log every attempt. Not needed today.

## Top finding

**R1 + R2 together — the rate-limit dance under load.** The two findings are the same shape: a single Bloomreach call that gets rate-limited can swallow ~57s of the 300s route budget under worst-case retry math, and the regex-based hint parsing means a wording change at Bloomreach degrades the math from "honor the stated window" to "exponential backoff." Neither is a today-bug, both are real exposure under specific failure modes.

The high-leverage fix isn't more retry logic — it's reducing the rate-limit hit-rate by raising the cache TTL beyond 60s for the EQLs the agent re-asks within one investigation. Today the cache helps within ~one investigation cycle; if it persisted across the whole 90-day window (which is the period-over-period unit the metrics analyze), most of the agent's queries would be served from cache and rate-limit retries would become rare.

That's a bigger change — it implies a real cache layer (LRU + TTL + invalidation), not just an in-process `Map`. But it's the only intervention that addresses both R1 and R2 at the source rather than treating each one's symptom.

## Primary diagram

```
  Audit map — finding → file → severity

  ┌─ /api/briefing + /api/agent ─────────────────────┐
  │  R6  no client-side timeout    [low]              │  hooks/useBriefingStream.ts:158
  │  R4  no backpressure check     [low]              │  app/api/briefing/route.ts:193
  └────────────────────────────────────────────────────┘
                  │
  ┌─ lib/data-source/bloomreach-data-source.ts ─────┐
  │  R1  retry math vs budget       [med]             │  :163-174
  │  R2  regex window parsing       [med]             │  :64-71
  └────────────────────────────────────────────────────┘
                  │
  ┌─ lib/data-source/index.ts ─────────────────────────┐
  │  R3  per-request connect        [low]             │  :85
  └────────────────────────────────────────────────────┘
                  │
  ┌─ lib/mcp/auth.ts ──────────────────────────────────┐
  │  R5  cookie size cap            [low]             │  :48
  │  R8  state validation off       [info]            │  :230 (+ callback:22-26)
  └────────────────────────────────────────────────────┘
                  │
  ┌─ lib/streaming/ndjson.ts ──────────────────────────┐
  │  R7  no flow-control            [trivial]         │  :17-64
  └────────────────────────────────────────────────────┘
                  │
  ┌─ lib/mcp/connect.ts ──────────────────────────────┐
  │  R9  alpha endpoint default     [low]             │  :32
  └────────────────────────────────────────────────────┘
                  │
  ┌─ lib/agents/base.ts ──────────────────────────────┐
  │  R10 Anthropic SDK retries      [low]             │  (SDK-managed)
  └────────────────────────────────────────────────────┘
```

## Elaborate

A few of these findings are interesting precisely because they're *not* worth fixing. R6 (no client-side timeout) and R7 (no flow-control) are conventional smells but their failure modes don't trigger in this app's profile. Adding the timeout means more code on a path that's already correct in practice; adding flow-control means optimizing for traffic that doesn't exist. Naming them is the value — knowing where the limits are means knowing where to look if the load profile changes.

R8 is the rarest kind of finding: a *deliberate non-fix* with a verification date. The note in the callback (`Verified live 2026-05-27.`) is itself the artifact — someone tried to validate state, observed the SDK's multi-call behavior breaking the naive check, and chose to leave validation off rather than re-implement properly today. That choice is documented in code; the helper is kept so the future implementation has a starting point. This is the right shape for "we know about this, here's why it's not a TODO."

R1 and R2 together are the highest-leverage area in the audit because they're the only findings that map to a user-visible failure mode (a long investigation timing out or returning an error after burning 30+ seconds of budget). The fix isn't in retry logic — it's in the cache layer. The current 60s in-process `Map` is the right shape for intra-investigation reuse; the missing piece is cross-investigation reuse over the 90-day metric window. That's a bigger architecture change (a real cache, with invalidation) than the scope of "audit findings" usually covers, but it's the actual move.

The architectural shape of the audit overall is reassuring: most findings are either (a) low-consequence under current load, (b) graceful-degradation paths that work but suboptimally, or (c) deliberately deferred with a documented reason. There are no "this can corrupt user data" findings. There are no "this leaks credentials" findings (the `redactSecrets` infrastructure at `lib/mcp/transport.ts:66` covers the log paths). There are no "this opens a port to the world" findings (all wires are TLS+auth). The network surface is sound; the audit is mostly about how it'd behave under load it doesn't see today.

## Interview defense

**Q: What's the highest-leverage thing to fix in the network layer?**

The rate-limit dance. R1 and R2 together describe a worst-case where a single rate-limited Bloomreach call eats ~57s of the 300s budget, and the math degrades to backoff if Bloomreach changes its error wording. The intervention isn't more retry logic — it's more aggressive caching, so the agent re-asks fewer EQLs within the same 90-day period-over-period window.

**Q: What in the audit is deliberate?**

Three things:

  - **R8 (state validation off)** — explicitly noted as a tested-and-verified deferral because the SDK validates internally.
  - **R6 + R7 (no client timeout, no flow-control)** — conventional smells whose failure modes don't trigger at current volumes; documented as load-profile-dependent.
  - **`maxDuration = 300` on Vercel Pro** — a deployment-platform constraint that R1's retry math depends on; documented in the code comment.

The audit is calibrated to "what's a real risk for this app" rather than "what does a checklist say."

**Q: Anything genuinely missing?**

Cross-instance cache (currently per-process), pooled MCP connections across requests, and a structured (not regex) rate-limit window parse — all upgrades, not bugs. The architecture leaves room for each but doesn't need them today.

## See also

  - `07-timeouts-retries-pooling-and-backpressure.md` — for the mechanics underlying R1, R2, R3, R4.
  - `04-tls-and-trust-establishment.md` — for the mechanics underlying R5, R8.
  - `06-websockets-sse-streaming-and-realtime.md` — for the mechanics underlying R6, R7.
  - `.aipe/study-security/` — for the trust-boundary version of the audit (what each finding means for an attacker).
  - `.aipe/study-distributed-systems/` — for the partial-failure version (what happens if Bloomreach is down rather than slow).

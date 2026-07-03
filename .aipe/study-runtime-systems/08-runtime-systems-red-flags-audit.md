# Runtime systems — red-flags audit

*Ranked execution-model risks · Project-specific*

## Zoom out — where this fits

The previous seven files walked mechanisms. This file ranks *risks*. Each finding is the shape of a bug that could actually land on Vercel, grounded in `file:line`, with a verdict on how load-bearing it is and what would break if the current mitigation went away.

The ranking axis is **consequence, not likelihood**: a rare bug that would corrupt user state ranks higher than a common bug that would only slow a request.

```
Zoom out — where each ranked risk sits on the map

┌─ Browser ─────────────────────────────────────────────┐
│  Risk 06 (StrictMode double-fetch)                     │
└─────────────────────────────────────────────────────────┘
                        │ HTTPS
┌─ Node process ────────▼───────────────────────────────┐
│  Risk 03 (ALS seeding failure)                         │
│  Risk 04 (session-Map bleed across users)              │
│  Risk 05 (monotonic-clock spacing gate)                │
│  Risk 09 (module-scope Map growth)                     │
│                                                         │
│  Investigation scope                                   │
│  Risk 01 (runaway agent loop) ★ HIGHEST CONSEQUENCE ★  │
│                                                         │
│  Call scope                                            │
│  Risk 02 (missing per-call timeout)                    │
│  Risk 07 (retry ladder capped for budget)              │
│  Risk 08 (concurrency ceiling in load harness)         │
└─────────────────────────────────────────────────────────┘
```

## Structure pass — the axis

Every finding here answers: **what stops the wrong thing from happening?** The mitigation is either "user code that stops the work" (safest) or "the platform stops the work eventually" (only OK as an outer bound).

## How it works — the ranked findings

Each finding names:

  → the risk shape (what could go wrong)
  → where the mitigation lives (`file:line`)
  → what happens if the mitigation is removed
  → confidence: **verdict** ("this is fixed") or **observation** ("this is bounded by X, not by code")

### 01 — Runaway agent loop burning cost after ceiling hit

**Risk:** an AptKit agent loop enters a bad state where each model turn produces another tool call, chaining indefinitely. Without a ceiling checked *before* dispatch, one bad case eats the whole 300s route budget and $2+ of Anthropic spend.

**Mitigation:** `BudgetTracker` gate in `lib/agents/aptkit-adapters.ts:60-66`, invoked pre-dispatch:

```ts
if (this.budget?.exceeded()) {
  throw new BudgetExceededError(this.budget.snapshot(), this.budget.limit);
}
```

**What breaks without it:** every runaway pays for one extra turn beyond the ceiling. Not catastrophic per case; catastrophic per day across a load run.

**Verdict:** fixed. The check is pre-dispatch (line 60 comment: *"check BEFORE dispatching the API call so a runaway loop can't burn additional cost after the ceiling has already been hit"*). The tracker is instance-scoped, shared across `DiagnosticAgent` + `RecommendationAgent` in one investigation via `AgentHooks.budget`. Wired for the eval load harness (`eval/load.eval.ts:265`). Route-handler wiring for production is TBD.

**Confidence:** high; tested indirectly through the load-harness receipts.

### 02 — Missing per-call timeout on MCP round-trips

**Risk:** a single hung Bloomreach connection burns the entire 300s route budget on one stuck call. No timeout means no way for a bad connection to signal "give up."

**Mitigation:** `TOOL_TIMEOUT_MS = 30_000` at `lib/mcp/transport.ts:38`, composed with the client-cancel signal at `:131, :150`:

```ts
const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
```

**What breaks without it:** worst-case one call = 300s. With 3 MCP calls in an investigation, you could burn the whole route budget on stuck calls before even reaching the model. The route's phase log would say "aborted at MCP call 2" with no useful cause.

**Verdict:** fixed. The comment at `lib/mcp/transport.ts:29-37` names the exact reasoning: *"A hung Bloomreach connection would otherwise burn the entire 300s route budget on one stuck call."* The 30s value is chosen deliberately — long enough for real Bloomreach latency (~2-5s typical), short enough that 3 retries × 30s ≈ 90s fits in the route budget.

**Confidence:** high.

### 03 — AsyncLocalStorage seed / flush failure

**Risk:** if the ALS `run()` wrapper is skipped (or misused) in production, provider methods that call `readAll()` fall back to reading the cookie inside every invocation. Next's "read after set in the same request returns the old value" bug bites, and OAuth flow state (PKCE verifier, client info) reads stale between calls.

**Mitigation:** `withAuthCookies` at `lib/mcp/auth.ts:86-104` runs every request-scope path inside `requestStore.run(ctx, fn)`. Both `connectMcp` and `completeAuth` wrap through it (`lib/mcp/connect.ts:68, :120`).

**What breaks without it:** every request pays multiple cookie decrypts + potential stale reads. The load-bearing example: the PKCE code verifier saved during `connect` reads as stale in the callback, and OAuth code exchange fails.

**Verdict:** fixed. The comment at `lib/mcp/auth.ts:39-46` names the exact hazard: *"Next's request-vs-response cookie split (a read after a set in the same request returns the OLD value), we never touch the cookie per provider-method call."*

**Confidence:** high; the connect + callback flow has been debugged against exactly this failure.

### 04 — Session-Map bleed across users on warm instance

**Risk:** `putInsights` is called from every briefing run. If the state Map is unkeyed (single `Map<insightId, Insight>` at module scope), one user's briefing wipes another user's feed mid-flight — literally, `state.clear()` on a warm instance affects every open session on that instance.

**Mitigation:** outer Map keyed by session id at `lib/state/insights.ts:14`; only *the caller's own sub-map* is cleared at `:64-66`.

**What breaks without it:** two concurrent users on the same warm instance see each other's insights disappear randomly.

**Verdict:** fixed. The comment at `lib/state/insights.ts:8-12` names the failure mode. The isolation is by naming discipline (session-keyed), which works because JS is single-threaded (see `04-shared-state-races-and-synchronization.md`).

**Confidence:** high; `test/state/insights.test.ts` verifies the isolation.

### 05 — Monotonic-clock spacing gate is best-effort, not atomic

**Risk:** two concurrent MCP calls on the same instance both read `lastCallAt`, both compute they're safe to send, and both hit Bloomreach at the same tick. Bloomreach returns 429 on one (or both).

**Mitigation:** the retry ladder at `lib/data-source/bloomreach-data-source.ts:163-174` absorbs the 429s, waits the stated window, and retries.

**What breaks without either:** cascading rate-limit errors surfaced to users.

**Observation:** the spacing gate at `:190-198` is deliberately not a lock — two concurrent readers can both pass the `elapsed < minIntervalMs` check simultaneously, both sleep, both fire at once. The comment at `bloomreach-data-source.ts` doesn't say this out loud, but the retry ladder is the real correctness fix.

**Confidence:** medium — the *design* is correct, but if the retry ladder were ever removed or misconfigured, this would surface as user-visible errors. The two mitigations are load-bearing together.

### 06 — StrictMode double-fetch in dev

**Risk:** React 19 dev-mode double-mounts every effect. Without a latch, every investigation fires twice on mount — one against MCP, wasted tokens.

**Mitigation:** `useRef(false)` latch at `lib/hooks/useInvestigation.ts:44-49`:

```ts
const startedRef = useRef(false);
useEffect(() => {
  if (!id) return;
  if (startedRef.current) return; // run once per mount (survives StrictMode)
  startedRef.current = true;
  // …
}, [id, step]);
```

**What breaks without it:** every investigation costs 2× in dev; visible when running the app locally. Doesn't affect production (no StrictMode in prod).

**Verdict:** fixed. The tricky nuance is that this hook deliberately does NOT cancel the fetch on cleanup — cancelling with a started-guard aborted the stream and left logs empty (see comment at `:33-37`). The tradeoff is deliberate: `setState after unmount is a safe no-op`.

**Confidence:** high; documented at the code, works in dev.

### 07 — Retry ladder capped so worst case fits budget

**Risk:** if the retry ceiling is too generous, one rate-limited call could burn most of the route budget before the ladder gives up. With original values it would have.

**Mitigation:** `retryDelayMs = 10_000`, `retryCeilingMs = 20_000`, `maxRetries = 3` at `lib/data-source/bloomreach-data-source.ts:133-136`. Worst-case single-call wall-clock: ~3 minutes, fits inside 300s.

**Observation:** the comment at `:161-162` reads: *"Latency note: against the 60s route budget (app/api/agent), maxRetries=3 at ~10s each can cost ~30s on a single call, so the cap stays low by default — raising it risks blowing the per-investigation budget."*

**Confidence:** medium — the numbers are chosen deliberately, but they encode assumptions about the outer route budget. If `maxDuration` changed (say, back to 60s Hobby), the retry cap would need to change with it. There's no automated check binding these values together.

**Would improve:** a shared constants module linking `TOOL_TIMEOUT_MS`, `retryCeilingMs * maxRetries`, and `maxDuration` so the relationship is one edit rather than two.

### 08 — Load-harness concurrency ceiling

**Risk:** `LOAD_CONCURRENCY = K` bounds parallelism against a live provider. Setting K too high triggers Bloomreach's per-user rate limit; setting K too low makes the test slow.

**Mitigation:** default K=3 at `eval/load.eval.ts:90`. Chosen for the ~1 req/s per-user limit (allows brief overshoot, then retries absorb the resulting 429s).

**Observation:** this is a test-only concern; the ceiling doesn't exist in production because production is a *user-serves-one-request* shape (Vercel concurrency happens across instances, not within one). The load harness's shared-queue + K-workers pattern is the only place user code owns "how much runs in parallel" in this codebase.

**Confidence:** medium — the K=3 default works but is empirically chosen. Real load numbers from the codebase state: `LOAD_N=2/K=1 → 208s wall clock (~104s/investigation)`. Higher K numbers not yet benchmarked at the level of "did we hit steady-state 429 storms."

### 09 — Module-scope Map growth over instance lifetime

**Risk:** `Map<sessionId, SessionFeed>` at `lib/state/insights.ts:14` and `Map<insightId, AgentEvent[]>` at `lib/state/investigations.ts:11` grow with every unique session/insight id that hits the instance. No explicit eviction.

**Mitigation:** none in code. Bounded by Vercel warm-instance lifetime (minutes to hours; then the process dies and the Map with it). Session ids are UUIDs (no reuse), so cumulative growth is bounded by "unique sessions in the instance's lifetime."

**What breaks without it:** on a hypothetical hour-long warm instance with sustained traffic, the Maps could grow into tens of MB. Not enough to hit the 1 GB Vercel limit, but a real leak in the ergonomic sense.

**Observation:** the current design relies on **platform behavior** for the bound, not code. This is the one finding in this file where the mitigation lives outside the codebase.

**Would improve:** an LRU cap or a periodic sweep. Not necessary today; would become necessary if Vercel changed to hour+ warm-instance lifetimes or if the app grew high enough sustained traffic.

**Confidence:** medium.

### 10 — No graceful-shutdown handler

**Risk:** on Vercel, functions can be killed without warning. Any in-flight state that would need explicit flushing (a background job queue, an unwritten log, an incomplete cache write) would be lost.

**Mitigation:** the codebase deliberately has nothing to flush. Every meaningful piece of state either:
  → lives in the browser (`sessionStorage`, `localStorage`);
  → lives in an external system (Bloomreach's session, Anthropic's request);
  → lives in a Vercel-managed cookie (the auth store);
  → is scoped to the request (dies with the response).

The one exception is the in-memory session Maps, which are already treated as ephemeral (the demo snapshot is the source-of-truth for presentation reliability).

**Observation:** this is a *design property*, not a mitigation. If a future feature added a background job or an accumulating log, this property would break silently. Worth naming so the guard doesn't get lost.

**Confidence:** high, as a design property; the property lives in the code's shape, not in any one line.

## Not yet exercised

Named to avoid false positives:

  → **Deadlocks** — impossible in single-threaded async without locks; the codebase has no locks. Not a risk.
  → **Race conditions across sync sections** — impossible in single-threaded JS.
  → **Memory leaks from event-listener buildup** — no long-lived subscribers in code. The `AbortSignal.addEventListener('abort', …, { once: true })` at `lib/mcp/transport.ts:186` uses `{ once: true }` explicitly to avoid buildup.
  → **`unhandledRejection`** — the codebase doesn't install a handler. Errors inside route-handler stream closures are caught by the outer `try/catch`; errors outside would kill the process. This is fine for Vercel serverless (the platform restarts).
  → **`process.on('SIGTERM')`** — not installed. Vercel doesn't send SIGTERM; it just kills. Nothing to flush anyway (see 10).

## Primary diagram — the ranked risks

```
Ranked runtime risks — by consequence, mitigations named

┌─ TIER 1: user-visible incorrectness ────────────────────────────┐
│                                                                  │
│  01 · Runaway agent loop            → BudgetTracker pre-dispatch │
│                                       aptkit-adapters.ts:60-66   │
│                                                                  │
│  02 · Hung MCP call blows budget    → AbortSignal.timeout(30s)   │
│                                       mcp/transport.ts:38, :131  │
│                                                                  │
│  03 · ALS seed / flush failure       → withAuthCookies            │
│                                       mcp/auth.ts:47, :86-104    │
│                                                                  │
│  04 · Session-Map bleed             → Map<sessionId, feed>       │
│                                       state/insights.ts:14       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

┌─ TIER 2: latency / cost ────────────────────────────────────────┐
│                                                                  │
│  05 · Spacing gate non-atomic       → retry ladder absorbs      │
│                                                                  │
│  06 · StrictMode double-fetch       → useRef latch              │
│                                       useInvestigation.ts:44    │
│                                                                  │
│  07 · Retry ladder budget-aware     → retryCeilingMs = 20_000   │
│                                       bloomreach-DS.ts:136      │
│                                                                  │
│  08 · Load-harness concurrency     → K=3 default                │
│                                       load.eval.ts:90           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

┌─ TIER 3: bounded by platform, not code ─────────────────────────┐
│                                                                  │
│  09 · Session-Map growth            → bounded by instance life  │
│                                       (no code eviction)         │
│                                                                  │
│  10 · No graceful shutdown         → nothing to flush           │
│                                       (design property)          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Elaborate — what a code review would flag if this were being upstreamed

Two observations that don't rise to "risk" but a reviewer would call out:

  → **The retry ladder constants + `maxDuration` are related but unlinked.** If `maxDuration` ever drops (Hobby's 60s), `retryCeilingMs * maxRetries + TOOL_TIMEOUT_MS` could exceed it. There's no test or constant binding these together. A `sharedBudgetConstraints` module would make the relationship explicit.

  → **The session-Map has no eviction.** Bounded in practice by Vercel instance lifetime, but the code doesn't defend it. On a review, this would earn either an explicit `// eviction not needed because…` comment or a bounded-size LRU. Currently it's implicit.

Neither is a bug today. Both are the shape of assumption that breaks when the platform behavior changes.

## Interview defense

**Q: Give me the highest-consequence runtime risk in this codebase and how it's mitigated.**

Runaway agent loops burning cost after the budget ceiling is hit. Mitigated by the `BudgetTracker` gate at `lib/agents/aptkit-adapters.ts:60-66`, which checks `budget.exceeded()` **before** dispatching each model turn. The pre-dispatch placement is load-bearing: post-dispatch would still pay for the runaway turn; pre-dispatch stops without adding cost.

The tracker is investigation-scoped (constructor per investigation), threaded via `AgentHooks.budget` through both `DiagnosticAgent.investigate()` and `RecommendationAgent.propose()` in the same investigation. So the running total carries across the diagnostic-to-recommendation boundary.

**Q: Which risk in this list is bounded by the platform, not by user code?**

The session-Map growth (risk 09). `Map<sessionId, SessionFeed>` at `lib/state/insights.ts:14` has no explicit eviction. Bounded in practice by Vercel warm-instance lifetime (minutes to hours; process dies and Map dies with it). If Vercel changed to longer-lived instances, or if traffic grew, we'd need an LRU cap.

The others in the list have user-code mitigations (`AbortSignal.timeout`, `BudgetTracker`, `useRef` latch, session-keying). This one relies on the platform's process-recycling behavior.

**Q: You said risks 05 and 07 have "medium confidence." Why not high?**

  → **05 (spacing gate):** the gate itself is not atomic — two concurrent callers can both pass the "safe to send" check and hit Bloomreach simultaneously. The retry ladder catches the resulting 429s, so the two mitigations are load-bearing *together*. If retry logic ever changed (say, retries were disabled for testing), the spacing gate on its own would let user-visible errors through.

  → **07 (retry ladder):** the ceiling values encode assumptions about the outer `maxDuration`. There's no test binding them together. Change `maxDuration` and the retry budget could silently exceed it. High confidence in the current *values*; medium confidence in the *design*, because the relationship isn't defended by code.

## See also

  → All previous files in this guide — each risk points back to a mechanism walked in detail elsewhere.
  → `study-testing` — the fault-injecting DataSource at `lib/data-source/fault-injecting.ts` induces exactly these failure modes to prove the mitigations work.
  → `study-debugging-observability` — the per-request `console.log({phases, aborted})` in each route's `finally` block is what surfaces these risks in production logs.

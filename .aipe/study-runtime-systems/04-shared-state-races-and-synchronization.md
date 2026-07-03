# Shared state, races, and synchronization

*Concurrency control · Language-agnostic (with JS-specific scopes)*

## Zoom out — where this concept lives

On a warm serverless instance, many requests share one Node process. That means module-level `Map`s, singletons, and any state above the request boundary is *shared* between concurrent requests. This concept is about how the codebase scopes that shared state so races don't happen — and where the closest thing to a race actually lives.

```
Zoom out — where shared state sits, per scope

┌─ Vercel warm instance (one Node process) ────────────────────────┐
│                                                                    │
│  ┌─ process scope ★ SHARED between all concurrent requests ★ ─┐  │
│  │  Map<sessionId, SessionFeed>       lib/state/insights.ts:14 │  │
│  │  Map<insightId, AgentEvent[]>      lib/state/investigations │  │
│  │  memStore: Map<string, State>      lib/mcp/auth.ts:36       │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─ request scope (AsyncLocalStorage) ──────────────────────────┐│
│  │  RequestStore { store: Store, dirty: boolean }               ││
│  │      lib/mcp/auth.ts:47                                       ││
│  │  seeded from cookie once, flushed once                       ││
│  │      lib/mcp/auth.ts:86-104 (withAuthCookies)                ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                    │
│  ┌─ instance scope (per-request DataSource) ────────────────────┐│
│  │  BloomreachDataSource:                                        ││
│  │    cache: Map<key, {result, expiresAt}>                      ││
│  │    lastCallAt: number  ★ the closest thing to a mutex ★      ││
│  │      lib/data-source/bloomreach-data-source.ts:122-123       ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                    │
│  ┌─ investigation scope (per-agent-run accumulator) ────────────┐│
│  │  BudgetTracker { inputTokens, outputTokens, turns }          ││
│  │      lib/agents/budget.ts:41-77                              ││
│  │  passed via AgentHooks.budget → same instance across         ││
│  │      diagnostic + recommendation for one investigation       ││
│  └──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

## Structure pass — one axis, four altitudes

Trace *"who else can see this state?"* down the scope stack. The answer sharpens at every level.

```
"Who else can see this state?" — one question, four answers

┌─ process scope ─────────────────────────┐
│  → EVERY request on this instance sees it│
│    → key by sessionId, never wipe outer  │
└────────────────┬─────────────────────────┘
                 ▼
┌─ request scope (ALS) ───────────────────┐
│  → ONLY this request sees it            │
│    → runs inside requestStore.run(…)     │
└────────────────┬─────────────────────────┘
                 ▼
┌─ instance scope (DataSource) ───────────┐
│  → this request's DataSource; a fresh    │
│    instance per makeDataSource() call    │
└────────────────┬─────────────────────────┘
                 ▼
┌─ investigation scope (BudgetTracker) ───┐
│  → both agent calls in one investigation │
│    share the same tracker instance       │
└──────────────────────────────────────────┘
```

The load-bearing seam: **process ↔ request.** This is where the answer to "who sees this" flips from *many* to *one*. The mechanism that carries that flip is `AsyncLocalStorage` (`node:async_hooks`) — the standard Node primitive for request-scoped state on top of a process-scoped runtime.

## How it works

### Move 1 — the mental model

You know how in React, `useState` scopes state to a component instance and `useContext` scopes it to a subtree? Same idea, different layer: `AsyncLocalStorage` scopes state to an async execution context (one request), sitting inside a Node process that hosts many.

```
The ALS pattern — process-wide storage, request-scoped access

  process-level singleton:
    const requestStore = new AsyncLocalStorage<RequestStore>()

  per-request entry:
    requestStore.run(context, () => {
      // any code called from here — including deep async awaits —
      // can call requestStore.getStore() and get THIS request's context
    })

  the magic:
    async code keeps its ALS context across `await`s
    (Node's async_hooks module tracks the async chain)
```

Without ALS, the OAuth provider's many `saveTokens` / `clientInformation` calls would each have to be passed the request's cookie state explicitly. With ALS, they call `requestStore.getStore()` from arbitrarily deep async code and get the right per-request context.

### Move 2 — the mechanisms

#### The load-bearing pattern: `withAuthCookies` (request-scoped state on a process-scoped runtime)

```
withAuthCookies — seed once, flush once, use many times

┌─ request start ─────────────────────────────────────────┐
│  read AUTH cookie → decrypt → build RequestStore{store} │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼ requestStore.run(ctx, fn)
┌─ inside ctx ──────────────────────────────────────────┐
│  MCP SDK calls provider.tokens()  ─►  readAll() reads │
│                                        ctx.store       │
│  MCP SDK calls provider.saveTokens() ─► patchState()   │
│                                          writes to     │
│                                          ctx.store,    │
│                                          sets dirty    │
└────────────────────┬──────────────────────────────────┘
                     │  fn() resolves
                     ▼
┌─ request end ─────────────────────────────────────────┐
│  if ctx.dirty: encrypt ctx.store → set cookie          │
│  otherwise: skip the cookie set                        │
└────────────────────────────────────────────────────────┘
```

Real code, annotated:

```ts
// lib/mcp/auth.ts:47, :86-104
const requestStore = new AsyncLocalStorage<RequestStore>();

export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();     // dev/test: passthrough

  const { cookies } = await import('next/headers');
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };

  const result = await requestStore.run(ctx, fn);              // ★ SEED ONCE
  //   |                                                          |
  //   |                                                          └── every deep async call
  //   |                                                              inside fn() sees ctx
  //   |                                                              via requestStore.getStore()
  //   ▼
  if (ctx.dirty) {                                            // ★ FLUSH ONCE
    (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), { … });
  }
  return result;
}
```

The load-bearing skeleton — what breaks if you remove each part:

  → Drop **the `requestStore.run(ctx, fn)` wrapper** and provider methods have no way to find their per-request cookie state; you fall back to reading the cookie inside every method, and Next's "read your write in the same request returns the old value" bug bites.
  → Drop **the `dirty` flag** and every request pays the cost of an encrypt + cookie set even when nothing changed.
  → Drop **the once-per-request seed** and each `readAll()` call re-reads the cookie, which triggers Next's request/response split and returns stale values.

The comment at `lib/mcp/auth.ts:39-46` names the exact bug this avoids: *"Next's request-vs-response cookie split (a read after a set in the same request returns the OLD value), we never touch the cookie per provider-method call."* Real production hazard, load-bearing fix.

#### The session-keying pattern: outer map never cleared

```
Session-keyed shared state — same map, isolated sub-maps

  Map<sessionId, SessionFeed>
    ├─ "session-A" ─►  { insights, investigations, anomalies }
    ├─ "session-B" ─►  { insights, investigations, anomalies }
    └─ "session-C" ─►  { insights, investigations, anomalies }

  putInsights(A, items):
    ┌───────────────────────────────────────────────┐
    │  const s = sessionState(A)                     │
    │  s.insights.clear()   ← only A's sub-map       │
    │  items.forEach(i => s.insights.set(i.id, i))   │
    └───────────────────────────────────────────────┘
    ★ never touches B or C ★
```

Real code, annotated:

```ts
// lib/state/insights.ts:14, :57-71
const state = new Map<string, SessionFeed>();     // ★ process-scoped

export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  // Replace the previous briefing for THIS session — each run IS the current
  // feed, not an addition. Without clearing, a warm serverless instance (or a
  // long-running dev server) accumulates stale insights from earlier runs, so
  // the feed shows yesterday's anomalies alongside today's. Investigations are
  // keyed separately and untouched here. Only this session's sub-maps are
  // cleared — never the outer map, never another session's feed.
  const s = sessionState(sessionId);              // get/create THIS session's feed
  s.insights.clear();                             // ★ ONLY THIS session's insights
  s.anomalies.clear();                            // ★ ONLY THIS session's anomalies
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}
```

The comment at `lib/state/insights.ts:8-12` names the exact concurrency hazard: *"A single warm Vercel instance serves many users concurrently, so module-level Maps would bleed between sessions — and putInsights' clear() would wipe another user's feed mid-briefing. Each session gets its own sub-feed; the outer map is never cleared by a request."*

The isolation is by **naming discipline** (key by session id, always) not by lock — because on a single event loop, the writes are atomic. Two concurrent `putInsights(A, …)` and `putInsights(B, …)` can't overlap; each runs a sync block between two awaits. The race would be *iterating* a session's map while another handler is writing to it — but the codebase reads a Map value into a local var before iterating (`listInsights` at `lib/state/insights.ts:81-84`), so even that isn't a hazard.

#### The one primitive that acts like a mutex: `lastCallAt`

```
Monotonic-clock spacing gate — no lock, no atomic, just a timestamp

// lib/data-source/bloomreach-data-source.ts:190-198 (annotated)
private async liveCall(name, args, signal) {
  const elapsed = Date.now() - this.lastCallAt;             // how long since last?
  if (elapsed < this.minIntervalMs) {                       // too soon?
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    // ★ every concurrent caller inside this instance also awaits their own sleep;
    //   Bloomreach still gets bunched calls if two hit "too soon" simultaneously,
    //   because there's no lock — the clock check is not atomic across awaits.
    //   This is fine: minIntervalMs = 1100 is a HINT, not an invariant.
    //   The real rate-limit enforcement is on Bloomreach's side (retry ladder handles it).
  }
  try {
    const result = await this.transport.callTool(name, args, { signal });
    this.lastCallAt = Date.now();       // ★ update AFTER the call resolves
    return result;
  } catch (err) {
    this.lastCallAt = Date.now();       // ★ also update on error (don't retry-storm)
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}
```

This is the closest thing to a synchronization primitive in the codebase, and it's deliberately NOT a lock. Two concurrent calls could both read `lastCallAt` as the same value, both compute the same `elapsed`, both sleep, and both hit Bloomreach simultaneously after the sleep. The spacing gate is best-effort; the retry ladder is the real correctness fix.

Why this is the right choice: a proper mutex would need something like a queue + a promise chain, which adds complexity for a case where the wrong outcome is *one extra HTTP call* (not corrupt state). The trade is deliberate.

#### The Phase-3 addition: BudgetTracker as investigation-scoped accumulator

```
BudgetTracker — an accumulator shared across two agent runs in one investigation

// eval/load.eval.ts:265 — construction
const budget = new BudgetTracker({ maxCostUsd: BUDGET_PER_INVESTIGATION_USD });

// diagnostic phase
const diagnosis = await diagnostic.investigate(golden.anomaly, {
  onCapabilityEvent: (ev) => diagnosisTrace.push(ev),
  onToolResult: (tc) => diagnosisToolCalls.push(tc),
  budget,                                    // ★ SAME instance passed here
});

// recommendation phase — same tracker, accumulated total carries over
const recommendations = await recommendationAgent.propose(golden.anomaly, diagnosis, {
  onCapabilityEvent: (ev) => recommendationTrace.push(ev),
  budget,                                    // ★ SAME instance
});
```

Inside `AnthropicModelProviderAdapter.complete()`:

```ts
// lib/agents/aptkit-adapters.ts:60-66
if (this.budget?.exceeded()) {
  throw new BudgetExceededError(this.budget.snapshot(), this.budget.limit);
}
```

The check runs **before** each API dispatch, not after. Why: if a runaway loop is going to burn cost, you want to stop it *before* the next call, not detect it after. The `add()` call at `lib/agents/aptkit-adapters.ts:107-110` accumulates usage after each response; the next `complete()` call reads the accumulated total and gates.

This is the interview-defense-tier detail: "the check is pre-dispatch, so a bad loop stops without adding another turn's cost." Anchor: `lib/agents/aptkit-adapters.ts:60-66`.

### Move 3 — the principle

**Scope the state to the lifetime that owns it, and races vanish before they start.** Every piece of shared state in this codebase has a name for its scope: `Map<sessionId, …>` for session, `AsyncLocalStorage<RequestStore>` for request, `BudgetTracker` (constructor per investigation) for investigation, `AbortSignal.timeout(30_000)` for call. The scopes never overlap in a way that would produce a race.

The pattern is: **when concurrent access could produce a wrong answer, don't guard the state — narrow its scope.** A `Map<sessionId, feed>` is safer than a single `feed` under a mutex, because the two writers never touch the same value. This is why the codebase has no locks, no atomics, no channels — it doesn't need them.

## Primary diagram — the full state map

```
Shared state and its scopes — one warm Node instance

┌─ Vercel warm instance (one Node process, one event loop) ────────┐
│                                                                    │
│  PROCESS SCOPE (survives every request on this instance)          │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Map<sessionId, SessionFeed>       lib/state/insights.ts:14 │  │
│  │ Map<insightId, AgentEvent[]>      investigations.ts:11     │  │
│  │ memStore: Map<sid, State>         mcp/auth.ts:36 (dev/test)│  │
│  │ prompt strings (legacy)           readFileSync at top       │  │
│  │                                                              │  │
│  │  ISOLATION: key by session; only sub-maps are cleared        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  REQUEST SCOPE (per HTTP request, via ALS)                        │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ RequestStore {store, dirty}       mcp/auth.ts:46, :47      │  │
│  │                                                              │  │
│  │  ISOLATION: requestStore.run(ctx, fn) — deep async calls    │  │
│  │  find THIS request's ctx via requestStore.getStore()        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  INSTANCE SCOPE (per DataSource, freshly built per request)       │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ cache: Map<key, {result, expiresAt}>                         │  │
│  │ lastCallAt: number   ← monotonic-clock spacing HINT          │  │
│  │   bloomreach-data-source.ts:122, :123                        │  │
│  │                                                              │  │
│  │  ISOLATION: DataSource lifetime = one request; no cross-req  │  │
│  │  sharing on THIS scope (only warm-instance cache in the      │  │
│  │  legacy path when clients were long-lived)                   │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  INVESTIGATION SCOPE (per investigation, threaded through hooks)  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ BudgetTracker instance             agents/budget.ts:41     │  │
│  │                                                              │  │
│  │  ISOLATION: constructor per investigation; same instance     │  │
│  │  passed to diagnostic.investigate() AND recommendation       │  │
│  │  .propose() via AgentHooks.budget — SHARED across both       │  │
│  │  agents in ONE investigation, isolated per investigation.    │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  CALL SCOPE (per MCP or Anthropic call)                           │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ AbortSignal from composeSignals(client, timeout)             │  │
│  │   mcp/transport.ts:131                                       │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## Elaborate — why "narrow the scope" beats "add a lock"

Locks in single-threaded async code are a category error most of the time. There's no preemption inside a sync section, so the race window is only across `await` boundaries. And *across await boundaries*, a lock either serialises access (killing throughput) or gets released while you're waiting (letting the race back in).

The clean answer is what this codebase does: give each concurrent thing its own state. Session-keyed maps for session state, ALS for request state, constructor calls for investigation state. Concurrent access still happens — it just happens to *different values*.

Where you can't narrow the scope (a shared cache, a single external rate limit), you make the concurrency safe by design: a Map read+write is atomic in one sync section, a monotonic clock is a hint not an invariant, an external rate limit is enforced by the external system not your code. The `BloomreachDataSource` spacing gate is exactly this reasoning applied.

## Interview defense

**Q: Show me a race you avoided by scoping instead of locking.**

`putInsights` in `lib/state/insights.ts:57`. On a warm serverless instance, two concurrent briefing runs both call `putInsights`. If the state were a single `Map<insightId, Insight>` and both handlers did `state.clear(); …items.forEach(state.set)`, the second `clear` would wipe the first briefing's insights before they could be read. The fix isn't a lock — it's `Map<sessionId, SessionFeed>` where each briefing writes to its own sub-map. Two concurrent writes touch different values; no race exists.

Anchor: `lib/state/insights.ts:14` (outer map) + `:64-66` (only sub-map cleared) + the comment at `:8-12` naming the failure mode.

**Q: What's the closest thing to a mutex in this codebase, and why isn't it a real mutex?**

`lastCallAt` at `lib/data-source/bloomreach-data-source.ts:123, :190-198`. It's a monotonic-clock timestamp that spaces MCP calls at ~1.1s intervals to respect Bloomreach's per-user rate limit. It's deliberately NOT a mutex: two concurrent callers can both read the same `elapsed`, both sleep, both hit Bloomreach at once. That's fine — the real rate-limit enforcement is on Bloomreach's side, and the retry ladder handles the resulting 429s. The `lastCallAt` gate is a HINT to reduce collisions, not an INVARIANT to enforce spacing.

If we made it a proper mutex, we'd add a queue + promise-chain lock, adding complexity for a case where the wrong outcome is one extra HTTP call, not corrupt state. The trade is deliberate.

**Q: Where does BudgetTracker's shared state live, and what's the failure mode it prevents?**

Instance-scoped: one `BudgetTracker` per investigation, constructed in the caller (route or eval), passed via `AgentHooks.budget` to both `DiagnosticAgent.investigate()` and `RecommendationAgent.propose()`. Same instance across both agents; they share the running total.

Failure mode prevented: a runaway agent loop burning tokens without a ceiling. The pre-dispatch `exceeded()` check at `lib/agents/aptkit-adapters.ts:64-66` throws `BudgetExceededError` *before* the next model call, so a bad case can't add another turn's cost after the ceiling is hit. Post-hoc detection would be too late — the money's already spent.

## See also

  → `01-runtime-map.md` — the scope diagram this file elaborates on.
  → `07-backpressure-bounded-work-and-cancellation.md` — the BudgetTracker gate as a form of bounded work.
  → `study-testing` — how the fake `_clearAuthStore`, `_clear(sessionId)`, and `_clearInvestigationCache` test-only exits keep state isolation testable.

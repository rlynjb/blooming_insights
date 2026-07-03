# Shared state, races, and synchronization

**Industry:** shared mutable state, cooperative synchronization, async-context propagation · Language-agnostic

## Zoom out — where this concept lives

The single-threaded rule from the last two files gives you a big gift: **no two lines of code run at the same time**. But it doesn't give you a free pass. Interleaving at `await` boundaries is still a race, and shared module-level state on a warm serverless instance is still shared across concurrent requests.

```
  Zoom out — where shared state lives

  ┌─ Browser ─────────────────────────────────────────┐
  │  localStorage · sessionStorage · React state      │
  │  (isolated per tab — no cross-user sharing)       │
  └───────────────────────┬───────────────────────────┘
                          │
  ┌─ Vercel serverless ──▼────────────────────────────┐
  │  ★ THIS CONCEPT ★                                  │
  │  module-level Maps · ALS-scoped stores · shared   │
  │  BudgetTracker · Bloomreach spacing clock          │
  │                                                    │
  │  ONE process, MANY concurrent requests             │
  └───────────────────────┬───────────────────────────┘
                          │
  ┌─ Upstream ──────────▼─────────────────────────────┐
  │  Bloomreach / Anthropic manage their own state    │
  └───────────────────────────────────────────────────┘
```

The concept: **synchronization on one thread means scoping and sequencing, not locking**. You don't reach for mutexes; you reach for AsyncLocalStorage (per-request scoping), session-keyed sub-maps (per-user partitioning), and check-before-dispatch patterns (sequential ordering).

## Structure pass — layers, axis, seams

Pick one axis — **who can see this piece of state?** — and trace it down.

```
  One axis (who can see it?) down the layers

  ┌─ per-request ──────────────────────────┐
  │  ALS-scoped RequestStore     → JUST     │
  │  (auth.ts:47)                  THIS req │
  └────────────────────────────────────────┘
      ↓ hop: request boundary
  ┌─ per-session ──────────────────────────┐
  │  Map<sessionId, SessionFeed>  → all reqs│
  │  (state/insights.ts:14)         from ONE│
  │                                 session │
  └────────────────────────────────────────┘
      ↓ hop: session boundary
  ┌─ per-instance ─────────────────────────┐
  │  BloomreachDataSource.lastCallAt  → all │
  │  (data-source/…:123)                sess│
  │                                    ions │
  │                                    on   │
  │                                    this │
  │                                    inst │
  └────────────────────────────────────────┘
      ↓ hop: instance boundary
  ┌─ cross-instance ───────────────────────┐
  │  bi_auth encrypted cookie  → EVERY inst │
  │  (client-owned)              that gets  │
  │                              the cookie │
  └────────────────────────────────────────┘

  every seam that flips the answer is a boundary where
  the wrong synchronization primitive would cause a bug
```

**The two most load-bearing seams:**

- **Request boundary** — the seam between "state that MUST be per-request" (auth tokens) and "state that CAN be per-instance" (Bloomreach spacing clock). Getting the wrong side means either duplicating work (per-instance auth = every request re-authenticates) or leaking identity (per-request Bloomreach clock = every request loses rate-limit history).
- **Session boundary** — the seam between "shared BY the same user across requests" (their feed) and "isolated FROM other users" (their feed vs someone else's feed). Getting this wrong is the identity-leak bug the ALS pattern was invented to prevent.

## How it works

### Move 1 — the mental model

You know how a React component with two `setState`s in one event handler will batch — both updates apply before re-render? That's the "no interleaving inside a synchronous stretch" rule. The event loop's version: no other task can run between any two of your synchronous statements. But the moment you `await`, another task can slip in.

```
  Pattern — the interleaving hazard

  task A:                task B:
  ─────────              ─────────
  read map[key]  ─┐
                  │
  await fetch()   │  ← A is paused here
                  ├──────► read map[key]
                  │        map[key]++
                  │        write map[key]
                  │        ─── B finished ───
                  ▼
  map[key]++
  write map[key]  ← A resumes, WRITES STALE value

  bug: two increments, only ONE observed change
  cause: A's read is stale by the time A writes
```

That's the shape of every JS "race": read → await → write, with the shared state changing during the await. The single-threaded model doesn't save you.

### Move 2 — the pieces

#### AsyncLocalStorage per-request scoping — the load-bearing pattern

The problem `lib/mcp/auth.ts` was invented to solve: OAuth flows involve many synchronous read/write calls on a provider. The MCP SDK's OAuth client asks for `clientInformation`, then `codeVerifier`, then saves `tokens` — all as synchronous method calls. If those all wrote to `next/headers` cookies individually, Next's cookie split (a `read` after a `set` in the same request returns the OLD value) would break the flow.

Solution: **seed a per-request store from the cookie ONCE, run the provider inside `ALS.run(ctx, fn)`, flush back ONCE at the end**.

```
  // lib/mcp/auth.ts:86-104 — the ALS-scoped store
  export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
    if (process.env.NODE_ENV !== 'production') return fn();
    const { cookies } = await import('next/headers');
    const raw = (await cookies()).get(AUTH_COOKIE)?.value;
    const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
    const result = await requestStore.run(ctx, fn);  // ← ALS.run scopes ctx to fn's async chain
    if (ctx.dirty) {
      (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), { … });
    }
    return result;
  }
```

Then every read/write goes through `readAll()` / `writeAll()` which check `requestStore.getStore()`:

```
  // lib/mcp/auth.ts:113-142 — every access flows through ALS
  function readAll(): Store {
    const ctx = requestStore.getStore();
    if (ctx) return ctx.store;  // production: ALS-scoped
    // dev/test fallbacks below…
  }

  function writeAll(store: Store): void {
    const ctx = requestStore.getStore();
    if (ctx) {
      ctx.store = store;
      ctx.dirty = true;
      return;
    }
    // dev/test fallbacks below…
  }
```

**Why it's safe under concurrency:** each incoming request calls `withAuthCookies(handler)`, which calls `requestStore.run(ctx, handler)`. Every `await` inside that handler propagates `ctx` — `AsyncLocalStorage` follows the async chain automatically. Two concurrent requests each get their own `ctx`; they never see each other's store, even though they run on the same event loop, same process, same module-level `requestStore` variable.

```
  Layers-and-hops — ALS scoping across concurrent requests

  ┌─ Vercel instance (one process, one event loop) ──────────────┐
  │                                                              │
  │  request A                    request B                      │
  │    │                            │                            │
  │    │  withAuthCookies(A_fn)     │  withAuthCookies(B_fn)     │
  │    │                            │                            │
  │    ▼                            ▼                            │
  │  ALS.run(ctx_A, A_fn) ─────►  ALS.run(ctx_B, B_fn) ────►     │
  │                                                              │
  │  ctx_A visible to A's        ctx_B visible to B's           │
  │  entire async chain          entire async chain             │
  │  (readAll, writeAll,         (readAll, writeAll,            │
  │   provider methods, …)        provider methods, …)          │
  │                                                              │
  │  ★ they NEVER see each other's store ★                       │
  └──────────────────────────────────────────────────────────────┘
```

**Without ALS:** the auth store would be a module-level `Map<sessionId, SessionAuthState>` (which it *is*, in test mode — `memStore` at line 36 — because tests are serial). In production, using that Map across concurrent requests would still work *only if* every read/write is keyed on the correct session — but the "correct session" concept lives in a cookie, which has the read-after-set problem. ALS bridges those two.

#### Session-keyed sub-maps — user isolation on one instance

`lib/state/insights.ts:14` is the other synchronization pattern. The problem: the feed state (insights + investigations + anomalies) needs to persist across the two-request pattern (briefing → investigate). But two users on the same warm instance would clobber each other if the state were flat.

```
  // lib/state/insights.ts:14-23 — session-keyed sub-feeds
  const state = new Map<string, SessionFeed>();

  function sessionState(sessionId: string): SessionFeed {
    let s = state.get(sessionId);
    if (!s) {
      s = { insights: new Map(), investigations: new Map(), anomalies: new Map() };
      state.set(sessionId, s);
    }
    return s;
  }
```

Then `putInsights` clears only *this session's* sub-maps:

```
  // lib/state/insights.ts:57-71 — clear only THIS user's feed
  export function putInsights(sessionId: string, items, rawAnomalies?) {
    const s = sessionState(sessionId);
    s.insights.clear();     // ← never state.clear() — that would wipe every user
    s.anomalies.clear();
    // …
  }
```

The comment at line 4-7 spells it out: without the outer `Map`, `putInsights`'s `clear()` would wipe another user's feed mid-briefing. The single-threaded rule doesn't help — the `putInsights` call from user A completes atomically, but it *wipes state user B still needs*. Sub-maps make each user's blast radius equal to just their own data.

**What the design still doesn't cover:** if the same user's `putInsights` runs *while* another of their requests is reading, you can still get "read stale then write" (the interleaving pattern). It hasn't bitten because each user's requests are serialized in practice (they don't kick off a briefing while another briefing is in flight).

#### The Bloomreach spacing clock — per-instance shared state that just works

`lib/data-source/bloomreach-data-source.ts:123` holds `private lastCallAt = 0` — a single number, updated on every call. This *is* shared across all sessions using the same DataSource instance, but the design accepts that:

```
  // lib/data-source/bloomreach-data-source.ts:191-200
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  // … make the call …
  this.lastCallAt = Date.now();
```

**Why it's safe:** the read (`Date.now() - this.lastCallAt`), the wait, and the write (`this.lastCallAt = Date.now()`) are separated by an `await` — the classic interleaving hazard. But *interleaving here is the intended behavior*: two concurrent calls both wait; both update `lastCallAt` to `Date.now()`; the second wait was shorter than the first because the first already ran. The invariant is "no two calls fire within `minIntervalMs`" — that's monotonic-clock-safe under interleaving because `Date.now()` never goes backwards. If the spacing is imperfect (two calls fire 50ms apart when 200ms was the goal), the Bloomreach server rejects the second one and the retry ladder catches it.

The lesson: **not every shared piece of state needs strict isolation**. A monotonic clock check is a synchronization primitive that tolerates the interleaving because the operation is idempotent (setting `lastCallAt = Date.now()` twice in quick succession is fine).

#### BudgetTracker — shared by two agents, safe by construction

`lib/agents/budget.ts:41` is a `BudgetTracker` instance shared across the DiagnosticAgent + RecommendationAgent for one investigation. It has mutable state (`inputTokens`, `outputTokens`, `turns`) and is checked-then-updated per model turn.

Why safe: the two agents **never run at the same time**. `app/api/agent/route.ts:283-289` runs them sequentially — diagnostic finishes, then recommendation starts. Inside one agent, model turns are also sequential. There's no interleaving to worry about because the two writers are handoff, not concurrent.

The `exceeded()` check happens BEFORE the next model turn (`lib/agents/budget.ts:71`) — a check-before-dispatch pattern:

```
  // conceptual — inside the model adapter's complete()
  if (budget.exceeded()) {
    throw new BudgetExceededError(budget.snapshot(), budget.limit);
  }
  const response = await anthropic.messages.create({…});
  budget.add({ inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens });
```

This is *not* a cancellation — an in-flight call to Anthropic still completes. The budget stops the *next* turn. That's the tradeoff: check-before-dispatch is easy to reason about (no mid-call cancellation), but a runaway agent still finishes its current model call before stopping.

#### Client-side state: localStorage + sessionStorage + reload

The browser has its own shared-state model: `localStorage` (persists across reloads) and `sessionStorage` (tab-scoped, cleared on close). `useInvestigation` uses both:

- `sessionStorage.getItem('bi:inv:<step>:<id>')` — per-step trace stash for back-nav
- `sessionStorage.getItem('bi:diag:<id>')` — diagnosis handoff between step 2 and step 3
- `localStorage.getItem('bi:mcp_config')` — persisted MCP config from the settings modal
- `localStorage.getItem('bi:mode')` — feed live mode

None of these have race issues *within one tab* — the browser's storage is synchronous single-threaded from your code's perspective. Cross-tab is a different story (a `storage` event fires in the other tab), but the app doesn't try to share state across tabs.

**Page reload as state-reset primitive:** `app/page.tsx:264` uses `window.location.reload()` after saving MCP config. The comment says why:

```
  // app/page.tsx:261-265
  onSaved={() => {
    // Fresh config → reload so the streaming fetch picks up the new
    // header on a clean state.
    if (typeof window !== 'undefined') window.location.reload();
  }}
```

The alternative would be a `configVersion` bumper + `useEffect` dependency, forcing all consumers to re-subscribe. Reload is simpler and clears the fetch cache too — the whole browser process resets. When state-tree invalidation is complex, reload is a legitimate synchronization move.

### Move 2 variant — the load-bearing skeleton

Every shared-state design in the repo boils down to a **kernel of three parts**. Strip any one and the design breaks.

1. **Isolate the kernel: partition + scope + sequence.**
   - Partition = sessionId (Map key)
   - Scope = ALS context (per-request)
   - Sequence = handoff (BudgetTracker: A finishes, then B starts)

2. **Name each part by what breaks when it's missing.**
   - Without **partition**: `putInsights` from user A wipes user B's feed.
   - Without **scope**: OAuth token from request A leaks to request B on the same instance.
   - Without **sequence**: two concurrent agents both check `exceeded()` and both pass, then both add to the budget → overshoot.

3. **Separate skeleton from optional hardening.**
   - Skeleton: the Map, the ALS, the sequential ordering.
   - Hardening: the encrypted cookie for cross-instance persistence, the 60s cache in the DataSource, the `dirty` flag on `RequestStore` to avoid unnecessary cookie writes.

### Move 3 — the principle

On a single-threaded runtime, **synchronization is a data-shape decision, not a locking decision**. You don't grab a mutex; you decide whether the state should be per-request, per-session, per-instance, or cross-instance, and you pick the primitive that matches (ALS, keyed Map, module var, encrypted cookie). Get the shape right and interleaving stops being a bug; get it wrong and no amount of locking helps.

## Primary diagram

```
  Shared state, races, and synchronization — the full picture

  ┌─ per-request  (auth tokens, PKCE verifier) ──────────────────┐
  │  AsyncLocalStorage<RequestStore>                             │
  │    seeded from bi_auth cookie at request start               │
  │    flushed back to bi_auth cookie at request end             │
  │    two concurrent requests → two contexts → no leak          │
  └──────────────────────────────────────────────────────────────┘
                             │  boundary
  ┌─ per-session  (feed, investigations) ────────────────────────┐
  │  Map<sessionId, SessionFeed>                                 │
  │    sub-maps hold insights / investigations / anomalies       │
  │    putInsights clears only THIS session's sub-map            │
  │    outer map is never cleared                                │
  └──────────────────────────────────────────────────────────────┘
                             │  boundary
  ┌─ per-instance  (Bloomreach clock, response cache) ───────────┐
  │  BloomreachDataSource.lastCallAt (single number)             │
  │    monotonic-clock check, tolerates interleaving             │
  │  BloomreachDataSource.cache (Map<name+args, result>)         │
  │    60s TTL, per-instance                                     │
  └──────────────────────────────────────────────────────────────┘
                             │  boundary (die on instance death)
  ┌─ cross-instance  (OAuth tokens) ─────────────────────────────┐
  │  bi_auth encrypted cookie (AES-256-GCM under AUTH_SECRET)    │
  │    survives instance handoff during OAuth callback           │
  │    SameSite=None so PKCE verifier survives cross-site return │
  └──────────────────────────────────────────────────────────────┘
                             │
  ┌─ per-investigation  (budget) ────────────────────────────────┐
  │  BudgetTracker (shared by DiagnosticAgent + RecommendationAgent)
  │    check exceeded() BEFORE next turn                         │
  │    add(usage) AFTER each response                            │
  │    safe because two agents run sequentially, not concurrently│
  └──────────────────────────────────────────────────────────────┘

  browser side:
  ┌─ per-tab (localStorage, sessionStorage) ─────────────────────┐
  │  bi:mcp_config, bi:mode, bi:inv:<step>:<id>, bi:diag:<id>    │
  │  reload = full state reset (used after config save)          │
  │  every helper guards typeof localStorage === 'undefined'     │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

`AsyncLocalStorage` came into Node 12 (stable in 14) as a replacement for `domain` (deprecated) and `cls-hooked` (userland). It's the JS answer to "thread-local storage" — except instead of pinning to a thread, it pins to an async task chain. The V8 promise machinery hands the context down every `await` automatically. That's why the pattern in `auth.ts` is safe without any explicit passing.

The other big idea in this file — session-keyed sub-maps — is straight out of the multi-tenant SaaS playbook. Every "who owns this row?" question gets answered with a partition key. The wrinkle here is that the "database" is a Node `Map` on a Vercel instance, not Postgres. The correctness argument is the same: **partition first, then reason about concurrency within a partition**.

Read `05-memory-stack-heap-gc-and-lifetimes.md` next — it walks how those Maps grow, when Node's GC reclaims them, and the "warm instance memory" failure mode. Then `07-backpressure-bounded-work-and-cancellation.md` shows how BudgetTracker composes with cancellation.

## Interview defense

**Q: The app runs on Vercel, warm instances serve many users. How do you prevent one user's OAuth token from leaking to another user's request?**

Two mechanisms compose. First, sessions are cookie-scoped — `getOrCreateSessionId()` reads a `bi_session` cookie or mints a new one, so every request has a stable session id. Second — this is the load-bearing part — the OAuth store in `lib/mcp/auth.ts` runs inside an `AsyncLocalStorage` context via `withAuthCookies`. Each request runs in its own ALS context; the MCP SDK's provider methods (which call `readAll`/`writeAll` under the hood) always see *this request's* store, never another's. Two concurrent requests on the same instance get two ALS contexts. There's no shared mutable auth state to leak.

*Diagram to sketch: one Vercel instance box containing two concurrent request arrows, each landing in its own ALS-context box, both drawn as isolated from each other despite sharing the same instance.*

**Q: The Bloomreach spacing clock (`lastCallAt`) is a single number shared across all users on one instance. Isn't that a race condition?**

It's a race — but the interleaving is safe *by construction*. The invariant is "no two calls fire within `minIntervalMs`" and `Date.now()` is monotonic. Two concurrent callers both check the elapsed time, both wait if needed, and both update `lastCallAt`. If they end up ~50ms apart when 200ms was the goal, the Bloomreach server enforces its stated rate limit via a 429, and our retry ladder catches it. So the shared state isn't the *sole* enforcement — it's opportunistic. If we wanted strict spacing we'd need a proper token-bucket with sequenced acquisition, and we don't have that yet.

*Diagram to sketch: two timelines racing to update the same `lastCallAt` box, both writing "Date.now()" — with an arrow to the Bloomreach 429 retry ladder as the safety net.*

**Q: What's the load-bearing part of the shared-state design people forget?**

That partitioning by session id inside a Map is *only* safe because `putInsights` clears the session's sub-map, not the outer Map. If someone naively wrote `state.clear()` inside `putInsights` — which looks reasonable if you don't notice the outer Map — every user's feed would be wiped on every briefing. The comment in `lib/state/insights.ts:4-7` calls this out explicitly. It's the kind of "obvious once seen" pattern that reads wrong the first time and correct the second time. Same-shape trap: `Map.clear()` inside a session-keyed Map is almost always a bug.

*Diagram to sketch: outer Map with three session boxes inside, one arrow labeled "s.insights.clear()" pointing at just one box (good), and one arrow labeled "state.clear()" with a red X pointing at the whole outer Map (banned).*

## See also

- `01-runtime-map.md` — where each of these state tiers lives on the runtime map
- `02-processes-threads-and-tasks.md` — the single-thread rule this pattern relies on
- `07-backpressure-bounded-work-and-cancellation.md` — BudgetTracker as sequencing primitive
- `.aipe/study-security/` — the AES-256-GCM cookie encryption at the cross-instance boundary

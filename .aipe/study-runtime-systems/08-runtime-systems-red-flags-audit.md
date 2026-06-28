# Runtime systems — red flags audit

**Industry name:** runtime-risk audit · **Type:** Project-specific findings

## Zoom out, then zoom in

This is the ranked list of things that would bite first under load, traffic spikes, or partial failure. Each finding is grounded in a real `file:line` and labelled by severity. The earlier concept files explain the *mechanism*; this file ranks the *risk*.

```
  Zoom out — where the risks cluster

  ┌─ band 1: client ──────────────────────────────────────┐
  │  R1: investigation hook never cancels on unmount     │  ← high
  └────────────────────────┬─────────────────────────────┘
                           │
  ┌─ band 2: server ★ THIS FILE ★ ───────────────────────┐
  │  R2: outer state Map grows monotonically             │  ← medium
  │  R3: ALS frame missing = silent prod auth failure    │  ← high
  │  R4: retry sleep is not signal-aware                 │  ← low
  │  R5: per-instance response cache, not per-process    │  ← low
  │  R6: no upper bound on tools-per-request             │  ← low
  └──────────────────────────────────────────────────────┘
```

Zoom in. The two highest-severity findings (R1 and R3) are both **deliberate-with-tradeoffs**, not bugs. The mid-severity one (R2) is unbounded retention with a platform-level reaper. The rest are minor — worth knowing, not worth fixing today.

## Structure pass

**Axis: blast radius — what fails when each risk fires?**

```
  Findings ranked by blast radius

  one user / one tab        one warm instance         one cold-start cycle
  ───────────────────       ──────────────────         ────────────────────
  R1: budget burn           R2: heap growth            R3: prod auth break
  R4: cancellation lag      R5: cache miss             R6: long-running req
```

The vertical axis is "how much does it impact." R3 (the ALS one) sits highest because it would break authentication for *every* user on the affected instance, silently. R1 burns budget for one user at a time. R2 builds up over minutes-to-hours until Vercel reaps the instance.

## The findings

### R1 — investigation hook deliberately doesn't cancel on unmount

**Severity:** high (budget) · **Evidence:** `lib/hooks/useInvestigation.ts:32-37, 46-50`

**What:** The `useInvestigation` hook fires a `fetch('/api/agent?…')` and consumes the NDJSON stream. The effect cleanup does NOT call `controller.abort()` or set a cancellation latch. The `startedRef` guard prevents a double-fetch on React StrictMode's mount-cleanup-remount; the in-flight stream simply runs to completion regardless of whether the component is still mounted.

```ts
// lib/hooks/useInvestigation.ts:46-50 (annotated)
useEffect(() => {
  if (!id) return;
  if (startedRef.current) return;          // ← run once per mount
  startedRef.current = true;
  // ... fetch + readNdjson ... no cleanup function returned
}, [id, step]);
```

**Why it's a risk:** A user navigates into an investigation, then SPA-navigates away (without closing the tab). The `/api/agent` request keeps running on the server, consuming Vercel function time and burning toward the 300s `maxDuration` ceiling. The browser doesn't sever the connection, so `req.signal` never aborts. The server runs to natural completion (or hits 300s).

**Mitigation in place:** Server-side cancellation IS plumbed for the *real* tab-close case — the browser severs TCP, `req.signal` aborts, the whole cancellation chain fires (`app/api/agent/route.ts:226-310`). Only the React-unmount-without-tab-close case is uncancelled.

**Verdict:** Honest tradeoff, not a bug. The comment at `lib/hooks/useInvestigation.ts:32-37` owns it. Fix would be a `useRef`-based cancellation latch that survives StrictMode's double-mount (the pattern `useBriefingStream` uses at `lib/hooks/useBriefingStream.ts:130-152`). Today, the cost is acceptable for an explicit-click-to-investigate UX.

**Reach:** one user's tab at a time, ≤300s of function budget per stranded request.

### R2 — outer `state` Map grows monotonically, no eviction

**Severity:** medium (heap pressure) · **Evidence:** `lib/state/insights.ts:14, 16-23`

**What:** The module-scope `Map<sessionId, SessionFeed>` adds a new entry every time a fresh `sessionId` calls `sessionState(sid)`. Entries are never evicted. The inner sub-maps are `.clear()`d per fresh briefing, so per-session memory stays bounded — but the outer map's entry count grows with distinct active sessions over the warm instance's lifetime.

```ts
// lib/state/insights.ts:14
const state = new Map<string, SessionFeed>();   // ← never .clear()'d, never evicted
```

**Why it's a risk:** With high traffic across many distinct sessions, the warm instance accumulates `SessionFeed` shells (each ~empty after a `.clear()`, but each pinned forever). At Vercel's typical instance lifetime (hours under steady traffic), this is bounded; at sustained high traffic with many distinct users, it could become measurable.

**Mitigation in place:** Vercel reaps idle instances; the process dying nukes the Map. No explicit eviction logic.

**Verdict:** Worth knowing, not worth fixing today. An LRU on the outer Map keyed by last-touch timestamp would be the clean fix — maybe 30 lines. Not earning its keep at current traffic.

**Reach:** one warm instance's heap.

### R3 — ALS frame missing = silent production auth failure

**Severity:** high (auth break) · **Evidence:** `lib/mcp/auth.ts:34, 86-104, 113-123`

**What:** The production auth backend is cookie-based, scoped to an `AsyncLocalStorage` frame established by `withAuthCookies`. The `readAll()` fallback hierarchy is:

```ts
// lib/mcp/auth.ts:113-123 (annotated)
function readAll(): Store {
  const ctx = requestStore.getStore();                 // ← inside ALS frame → use ctx
  if (ctx) return ctx.store;
  if (!PERSIST) return Object.fromEntries(memStore);   // ← dev/test → memory Map
  try { if (existsSync(CACHE_FILE)) return JSON.parse(...); }  // ← dev → file
  catch { /* ignore */ }
  return {};                                            // ← LAST RESORT: empty store
}
```

In production (`NODE_ENV === 'production'`, `PERSIST === false`), if any auth-touching call happens *outside* a `withAuthCookies` wrapper, `getStore()` returns `undefined`, the function falls through to the dev branch (which is skipped because `PERSIST` is false), and finally returns an **empty store**. The OAuth provider then sees "no tokens, no client info" and starts a fresh OAuth flow.

**Why it's a risk:** A single forgotten `withAuthCookies(() => …)` wrapper anywhere in a production handler punches a hole. The symptom would be intermittent unexpected re-auth redirects with no obvious error.

**Mitigation in place:** Today, every auth-touching route IS wrapped. The codebase pattern is `withAuthCookies(() => makeDataSource(...))`. The risk is a *future* handler that forgets the wrapper.

**Verdict:** Architecturally tight today; one missed wrapper away from silent failure. Would benefit from a lint rule or a type-level guard. The dev/test fallbacks (memory + file) mask the symptom locally — you wouldn't catch the missing wrapper until prod.

**Reach:** every user on the affected instance (broken auth, silent re-auth loops).

### R4 — retry sleep is not signal-aware

**Severity:** low (cancellation lag) · **Evidence:** `lib/data-source/bloomreach-data-source.ts:73-75, 163-174`

**What:** The rate-limit retry ladder uses `sleep(waitMs)` (a plain `setTimeout` Promise) which doesn't observe the `signal`:

```ts
// lib/data-source/bloomreach-data-source.ts:73-75
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));   // ← no signal check
}

// :172
await sleep(waitMs);                              // ← can be up to 20_000ms
result = await this.liveCall(name, args, options.signal);   // ← signal observed AFTER sleep
```

**Why it's a risk:** A client cancels mid-retry-wait. We sleep the full `waitMs` (up to 20s capped by `retryCeilingMs`) before the next `liveCall` sees the aborted signal and throws. Net effect: cancellation latency = remaining retry wait, up to 20s extra.

**Verdict:** Minor. Fix would be a signal-aware sleep helper that races `setTimeout` against `signal.addEventListener('abort', ...)`. Not in the codebase today.

**Reach:** ≤20s cancellation lag, per stranded request.

### R5 — response cache is per-DataSource-instance, not per-process

**Severity:** low (cache miss rate) · **Evidence:** `lib/data-source/bloomreach-data-source.ts:122` + `lib/mcp/connect.ts:96` (fresh instance per `connectMcp`)

**What:** The 60s response cache lives on the `BloomreachDataSource` instance. The instance is constructed fresh in `connectMcp` per request, so the cache is effectively per-request. Two `/api/agent` requests for the same insight on the same warm instance each get their own empty cache and re-fetch the same tools.

**Why it's a risk:** Higher Bloomreach tool-call volume than necessary. The bootstrap chain (`list_cloud_organizations`, `list_projects`, `get_event_schema`) fires twice for two consecutive requests instead of being absorbed by a shared cache on the second one.

**Verdict:** Worth noting, not worth fixing today. Lifting the cache to module scope would absorb cross-request repeats; it'd need key-partitioning by `sessionId` (the same discipline as `state` in `lib/state/insights.ts`). Today the bootstrap takes ~3-5s; cross-request cache hits would save that on every subsequent request from the same warm instance. Real win if traffic to a single instance is high; minor otherwise.

**Reach:** one user's traffic to one warm instance — measured in seconds-per-request, not correctness.

### R6 — no upper bound on tools-per-request

**Severity:** low (budget burn) · **Evidence:** absence; `app/api/agent/route.ts` has no per-iteration cap on `runAgentLoop`

**What:** The agent loop runs until Claude stops calling tools or `req.signal` aborts. There's no hard cap like "max 50 tool calls per investigation." The spacing gate (~1.1s) + the 30s per-call timeout + the 300s route ceiling form an implicit cap (~270 tools max), but no explicit one.

**Why it's a risk:** A pathological agent run (loop, mis-prompted) could burn the full 300s budget on tool calls. Less a runtime risk than a prompt-design one — but the runtime is what bills the budget.

**Verdict:** Implicit bound is acceptable today. An explicit `maxToolCalls` ceiling in the agent loop would be defense-in-depth.

**Reach:** one request at a time.

## Not yet exercised

Things a runtime-systems audit would normally flag, that don't apply because the underlying mechanism isn't in the codebase:

  → **Worker thread starvation.** No `worker_threads`. No risk.
  → **Child-process lifecycle leaks.** No `child_process` / no subprocesses. No risk.
  → **Cluster master-worker race conditions.** No cluster mode. No risk.
  → **File-descriptor leak from streamed file I/O.** No `fs.createReadStream` / no streamed file I/O. The sync `readFileSync` / `writeFileSync` calls close fds automatically. No risk.
  → **GC pause during high allocation.** No deliberate GC tuning; no allocation hot path. The agent loop is I/O-bound, not allocation-bound. Not a current concern.
  → **`process.SIGTERM` graceful shutdown.** Not subscribed. Vercel terminates instances; we don't drain in-flight work. Acceptable because the in-flight work is regenerable (insights / investigations) and durable state (auth tokens) lives in the cookie.
  → **Backpressure on `controller.enqueue` when the consumer is slow.** Not handled — the ReadableStream interface allows `enqueue` to return a Promise the producer should await, and the codebase doesn't. For NDJSON of small events at sub-1KB each, this hasn't surfaced. If we ever streamed large payloads, this would matter.

## Primary diagram

```
  Runtime red flags — ranked by blast radius and severity

                            severity high
                                 │
                  ───────────────┼────────────────
                                 │
                R3 (auth break)  │  R1 (budget burn)
                process-wide     │  per-user
                                 │
                  ───────────────┼────────────────  blast radius:
                                 │                  one user → one instance
                                 │  → process
                R2 (heap growth) │  R5 (cache miss)
                instance-wide    │  per-instance
                                 │
                R4 (cancel lag)  │  R6 (no tool cap)
                per request      │  per request
                                 │
                            severity low
```

## Interview defense

**Q: What's the worst-case runtime failure mode of this app?**

R3 — a forgotten `withAuthCookies` wrapper in a future production handler. The dev/test backends (memory + file) would mask the missing wrapper locally; in production, every auth read would return an empty store, the OAuth provider would think the user has no tokens, and the user would get caught in a re-auth loop with no error message.

The reason it's "worst-case" rather than "currently broken": today every production handler IS wrapped. The risk is architectural — one bad PR away. Defense would be a lint rule that flags any `BloomreachAuthProvider` construction outside `withAuthCookies` scope, or a type-level marker on functions that touch the auth store.

Anchor: "ALS frame missing in prod = silent auth break for everyone on the instance."

```
  dev / test backends: file / memory (mask the bug)
  prod backend: cookie via ALS → if no ALS, empty store
       ↓
  auth state always missing
       ↓
  every request looks like first-time-user → re-auth loop
       ↓
  user has no idea why
```

**Q: What's the highest-impact runtime risk that's actually a deliberate tradeoff?**

R1 — `useInvestigation` deliberately not cancelling on React unmount. The comment at `lib/hooks/useInvestigation.ts:32-37` owns the call: React StrictMode's mount-cleanup-remount dance would otherwise abort the stream on the first cleanup, the started-guard would block the re-mount from re-fetching, and the user would see an empty trace.

The cost paid: a user who SPA-navigates away from an investigation page keeps the server function running for up to 300s. For our UX (explicit click to investigate, users typically stay on the page), the tradeoff is fine.

The fix if we ever needed it: a `useRef`-based cancellation latch that survives StrictMode (the pattern `useBriefingStream` uses at `lib/hooks/useBriefingStream.ts:128-152`). It would replace the unconditional opt-out with a "cancel ONLY when truly unmounting, not on StrictMode re-mount" discipline.

```
  tradeoff:
   safety:    StrictMode-safe (trace populates correctly)
   cost:      stranded server runs on SPA nav-away (≤300s each)
   measured:  acceptable for explicit-click investigations
```

## See also

  → `01-runtime-map.md` for the resource lifetimes that frame these risks.
  → `04-shared-state-races-and-synchronization.md` for the partition discipline that keeps R2's growth from causing actual races.
  → `07-backpressure-bounded-work-and-cancellation.md` for the cancellation chain R1/R4 sit on.

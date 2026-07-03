# Runtime systems red flags — ranked audit

**Industry:** runtime-systems risk register · Project-specific

## Zoom out — where this file sits

The other seven files describe what's there. This file names what would break under stress, ranked by consequence. Every entry is grounded in a `file:line` range so a reviewer can open the code and check.

```
  Zoom out — the audit's place

  ┌─ 01–07: how it works (grounded description)  ┐
  │                                                │
  │  runtime map · threads · event loop · state    │
  │  memory · streams · bounded work               │
  └─────────────────────┬──────────────────────────┘
                        │
  ┌─ 08 ─ this file ──▼──────────────────────────┐
  │  ranked risks with evidence                   │
  │  ★ THIS FILE ★                                 │
  └───────────────────────────────────────────────┘
```

The concept: **rank by consequence, not by frequency**. A risk that never fires but would take down the fleet if it did outranks a risk that fires often but each fire is a soft-fail. Every entry names *what breaks* and *the code that would need to change*.

## Structure pass — layers, axis, seams

Pick one axis — **what's the worst-case blast radius?** — and trace it.

```
  One axis (worst-case blast radius?) across risk tiers

  ┌─ tier 1 ─ identity or data leak ──────────────┐
  │  cross-user token leak · cross-user feed wipe │
  │  → costs trust                                │
  └──────────────────────────────────────────────┘
      ↓
  ┌─ tier 2 ─ availability or cost blowup ────────┐
  │  stuck route burns 300s · runaway agent burns │
  │  budget · unbounded Maps leak on long-running │
  │  → costs uptime / dollars                     │
  └──────────────────────────────────────────────┘
      ↓
  ┌─ tier 3 ─ dev-ergonomics or UX degradation ───┐
  │  hot-reload wipes flow · SSR crash on         │
  │  localStorage · sessionStorage quota          │
  │  → costs velocity / edge-case users           │
  └──────────────────────────────────────────────┘

  higher tier = smaller blast radius but real
```

The seams that concentrate the risks: **the ALS scope** (tier 1 hangs on it), **the AbortSignal composition** (tier 2 hangs on it), **the SSR/browser split** (tier 3 hangs on it).

## The ranked findings

### 1 — Session-keyed Maps have no LRU or TTL, only process-death cleanup

**Blast radius:** unbounded memory growth if we ever moved off serverless. Not a live bug today.

**Evidence:**
- `lib/state/insights.ts:14` — `const state = new Map<string, SessionFeed>()`
- `lib/state/investigations.ts:11` — `const mem = new Map<string, AgentEvent[]>()`
- `lib/mcp/auth.ts:36` — `const memStore = new Map<string, SessionAuthState>()` (dev/test only)

**Why it's ranked #1:** the design's *entire* correctness depends on Vercel killing instances every ~15 min of idle. The moment you deploy this to a long-running Node server (Docker on Fly.io, a home server, a self-hosted VPS), the same code leaks. Every session that ever hits the process stays in the Map forever. Comments in `insights.ts:4-7` name the constraint but the code doesn't enforce it.

**What'd fix it:** an LRU wrapper (say, 1000 most-recent sessions) or a TTL sweep (drop sessions untouched for >1h). Neither is worth adding today — the workload is serverless — but naming this as the #1 risk for a runtime move is honest.

### 2 — 30s per-call timeout isn't a retry ceiling — a single call can burn ~30s of the 300s budget

**Blast radius:** one investigation with 10 stuck calls = 300s burned, no result. The user sees a Vercel platform kill, not a graceful error.

**Evidence:**
- `lib/mcp/transport.ts:38` — `TOOL_TIMEOUT_MS = 30_000`
- `lib/mcp/transport.ts:131` — timeout composed into every call
- `lib/data-source/bloomreach-data-source.ts:130-136` — `maxRetries = 3`, retry ceiling 20s

**Why it's ranked #2:** the 30s timeout is a *per-call* ceiling, and each call also has up to 3 retries at up to 20s each — one hung call can cost 30s, three retries can cost 90s. If the agent makes 5 calls in an investigation and each retries once, we're already at 250s of the 300s budget with no headroom for the model. The retry ladder doesn't retry timeouts (line 138 comment), so a single 30s wait doesn't chain — but a slow-then-succeeds pattern (25s then 25s across two calls) still eats budget.

**What'd fix it:** a *cumulative* time budget on the investigation itself, not just per-call. Something like `if (performance.now() - t0 > 200_000) throw new BudgetExceededError` before each phase. The BudgetTracker is USD-only today; extending it to wall-clock would be a small addition.

### 3 — `throwIfAborted()` checkpoints are at phase boundaries, not inside long-running phases

**Blast radius:** if the client disconnects mid-agent-loop, cancellation only fires at the next phase boundary (usually after the current model turn completes). Up to one model turn of work wasted.

**Evidence:**
- `app/api/agent/route.ts:231, :242, :253, :279, :287` — checkpoints at phase transitions
- Inside `DiagnosticAgent.investigate` (called at line 287), no `signal.throwIfAborted()` between turns (relies on the composed signal reaching `messages.create`)

**Why it's ranked #3:** the composed AbortSignal *does* propagate into the underlying fetch, so if a client disconnects mid-model-call, the call aborts. But if the model has already returned and the loop is about to call the next tool, cancellation fires at the tool's fetch — one turn's worth of latency wasted before it aborts. Not costly (a single model turn is a few seconds), but visible.

**What'd fix it:** a `signal.throwIfAborted()` inside the agent loop between each turn. `aptkit-core` may or may not expose that hook — worth checking. Low-impact fix; low-priority to do.

### 4 — The dev-only file-based auth cache is a permission trap in some environments

**Blast radius:** if the process runs in a read-only-FS container (some CI, some Docker configs), the sync write silently fails — auth state doesn't persist, OAuth flows break mid-callback.

**Evidence:**
- `lib/mcp/auth.ts:34-35` — `PERSIST = process.env.NODE_ENV === 'development'` gates the file path
- `lib/mcp/auth.ts:138-141` — write is best-effort with a silent catch

**Why it's ranked #4:** the silent catch means the failure is invisible until an OAuth flow spans a hot-reload and loses state. Debugging that means noticing state disappearing — non-obvious in the moment. The failure only matters in dev-like environments; production uses the ALS/cookie path entirely, sidestepping this.

**What'd fix it:** log a warning on the first write failure (once per process) so dev sees the message. Or migrate the dev path to also use in-memory + a manual "OAuth flows survive hot reload" hack (harder).

### 5 — Bloomreach spacing gate's `await sleep()` is not cancel-aware

**Blast radius:** if the client disconnects during the pre-call spacing wait, we sleep out the wait (up to 200ms) before checking the abort. Not user-visible, but a small latency leak.

**Evidence:**
- `lib/data-source/bloomreach-data-source.ts:191-194` — `await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed))`

**Why it's ranked #5:** small blast radius, fires often, but nobody notices. The 200ms max is inside the 300s budget's noise floor. Worth naming because it's a *pattern* that could grow — if `minIntervalMs` ever became 10_000, the same bug would be user-visible.

**What'd fix it:** race the sleep against the signal — `await Promise.race([sleep(ms), signalAsPromise(signal)])`. Twenty lines. Not worth doing until the workload changes shape.

### 6 — MCP SDK Client reuse across requests holds transport-pool state across sessions

**Blast radius:** if a session's cookie rotates mid-flight (rare), the SDK Client held for that session becomes stale. Next request builds a new one via `makeDataSource`; the stale one gets `dispose`'d in the finally.

**Evidence:**
- `app/api/agent/route.ts:172` — `dsResult = await makeDataSource(mode, sid, mcpConfigOverride)`
- `app/api/agent/route.ts:186` — `const disposeDataSource = dsResult.dispose`

**Why it's ranked #6:** the dispose path is called in `finally`, so cleanup is reliable. The only failure mode would be a *forgotten* dispose (which happens today only if the ReadableStream's `start` throws before assigning `disposeDataSource` — inspection of the code says no, but the correctness margin is thin).

**What'd fix it:** move the dispose to run *inside* the ReadableStream's finally (currently the dispose might be in the surrounding route handler flow — verify by opening the file). Also could add a `WeakRef`-based Client cache with automatic release, but that's over-engineering for a workload that hasn't hit the problem.

### 7 — SSR guards are correct but relied on defensively — one missed guard would crash a server render

**Blast radius:** a component that imports `readPersistedConfig()` at module top-level (instead of inside an effect) would call `localStorage.getItem` during SSR and throw.

**Evidence:**
- `lib/mcp/config.ts:107, :122, :143` — every helper guards `typeof localStorage === 'undefined'`
- `lib/hooks/useInvestigation.ts:159` — extra `typeof window !== 'undefined'` guard even inside a `'use client'` file

**Why it's ranked #7:** the current code is safe. The risk is a future contributor writing `const initial = readPersistedConfig()` at module top and shipping it in a server component. The pattern would break; the SSR guards would still return null; nothing would crash. But the *variant* — someone directly touching `localStorage.getItem(key)` without going through the helper — would throw. The convention is "always go through the helper," and the helper is safe.

**What'd fix it:** an ESLint rule banning direct `localStorage`/`sessionStorage` outside a `useEffect` or a `typeof` check. Low-effort. Not present today.

### 8 — The `startedRef` latch relies on undocumented React 19 remount behavior

**Blast radius:** if a future React version's StrictMode does something different (say, a synchronous remount that shares the ref), the fetch would fire twice. Not user-visible in the current version.

**Evidence:**
- `lib/hooks/useInvestigation.ts:45-50` — `useRef(false)` + effect-body latch

**Why it's ranked #8:** the pattern is documented as "StrictMode-safe" in the comment, but it's a load-bearing correctness argument based on how React allocates refs per mount. React 19 respects this; React 20 might change it. Low probability, low blast radius (a duplicate fetch that both finish and clobber each other's `setState` calls).

**What'd fix it:** an `AbortController` in the effect cleanup that aborts the fetch — but the comment at `useInvestigation.ts:34-38` explains why the team explicitly chose NOT to do that. The alternative (which the comment endorses) is accepting the current design as it is. Nothing to fix; worth naming as a known constraint.

### 9 — No CPU-bound work exists today; if it appeared, it would block the event loop

**Blast radius:** hypothetical. The current code has no CPU-heavy operations (truncated JSON, small AES ops, small parsing).

**Evidence:**
- Grep confirms no `worker_threads` import
- Heaviest operations: `JSON.parse` on tool results (truncated to 4000 bytes at `app/api/agent/route.ts:98`)

**Why it's ranked #9:** if someone added a CPU-bound op (say, embedding computation, or large XML parsing, or a scheduled sorting job), it would block the event loop for its duration. On a warm serverless instance serving many users, that would freeze other requests too. The current design has no reason to add such an op, but it's not enforced.

**What'd fix it:** if the workload ever included CPU-heavy tasks, `worker_threads` or moving the work to a Vercel Edge Function (with the appropriate runtime) would be the move.

### 10 — Eval receipts directory grows unbounded

**Blast radius:** disk space on the eval-runner's machine. Zero user impact.

**Evidence:**
- `eval/load.eval.ts:135, :219-220` — `mkdirSync(RECEIPTS_DIR)`, `writeFileSync(outPath, …)`
- `eval/receipts/` and `eval/load-receipts/` accumulate one file per run

**Why it's ranked #10:** it's not really a runtime bug — it's a housekeeping oversight. Named for completeness because "unbounded growth" is a category worth calling out even when the growth is trivial.

**What'd fix it:** a `.gitignore` line + a periodic `rm eval/*-receipts/*.json` in the developer's workflow. Or a housekeeping step in the eval harness itself (keep last N, delete the rest).

## Summary — where the real risks live

```
  The audit at a glance

  Risk                                Tier    Fixed by
  ──────────────────────────────────  ────    ─────────────────────
  1 Session Maps have no LRU/TTL      T2      LRU wrapper (later)
  2 30s × N calls burns route budget  T2      wall-clock budget
  3 throwIfAborted at phase bounds    T3      per-turn checkpoint
  4 dev-only FS cache silent fail     T3      warn once on error
  5 spacing sleep not cancel-aware    T3      race sleep vs signal
  6 SDK Client reuse edge case        T3      inspect dispose flow
  7 SSR guards depend on convention   T3      ESLint rule
  8 startedRef ties to React 19       T3      accept as known
  9 no CPU-bound work today (hypo)    T3      worker_threads if needed
 10 eval receipts unbounded           T3      housekeeping

  the two that matter:
    · #1: correctness assumption tied to serverless-only deployment
    · #2: layered ceilings don't compose into a single wall-clock guard
```

Every entry in the list is small. That's the honest read: `blooming_insights` has good runtime discipline. The load-bearing patterns (ALS scoping, AbortSignal composition, session-keyed sub-maps, check-before-dispatch) are correctly implemented, and the biggest risks are second-order — assumptions about the deployment shape (#1) and gaps in the ceiling composition (#2).

## What's not on the list

- **No shared-state race that's live today.** The four patterns in `04-shared-state-races-and-synchronization.md` all hold under current concurrency.
- **No memory leak visible in the current workload.** The Maps grow with sessions but Vercel kills instances before they get big.
- **No hung stream path.** Every producer has a `finally { controller.close() }`; every consumer reads until done.
- **No cancellation blackhole.** Every await-able operation observes `req.signal` or composes it.

## See also

- `01-runtime-map.md` — the map that grounds every risk to a runtime tier
- `04-shared-state-races-and-synchronization.md` — why the shared-state risks aren't tier-1 (partition + ALS + sequence)
- `07-backpressure-bounded-work-and-cancellation.md` — the ceilings that #2 says don't compose fully yet

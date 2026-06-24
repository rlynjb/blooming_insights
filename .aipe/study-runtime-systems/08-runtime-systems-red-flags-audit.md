# 08 — Runtime systems red-flags audit

**Industry name(s):** runtime risk audit · execution-model failure modes · ranked operational risks
**Type:** Project-specific · Verdict-led ranking

> **Verdict (Phase 2): the runtime is well-bounded and getting less operationally naive — but Phase 2 introduced one genuinely new risk (orphan subprocess) and one that's a runtime-orchestration variant of an existing test-isolation risk (parallel K=10 eval scripts).** The agent loop, the spacing gate, the forced-synthesis turn, the `try/finally controller.close()`, the `AsyncLocalStorage` for auth, and the new `composeSignals` + `AbortSignal.timeout(30_000)` per-call wall are all done correctly. The risks are still at the *seams the code doesn't cover*: process-local state on serverless, the half-wired browser→route cancellation (now half-WIRED, not fully absent), and — new — no automatic subprocess cleanup on parent crash, no `process.on('exit')` reaper, no inter-script lockfile for the eval flywheel. None of these are bugs at hackathon scale. All of them are landmines at production scale (or, for the parallel-run risk, at "two agents working in the same repo" scale). Ranked below by consequence × likelihood-at-current-scale.

---

## Zoom out, then zoom in

**Zoom out — where the risks live.** Almost every risk in this audit sits on one of three seams the prior concepts established:

```
  The risk surface — four seams now (Phase 2)

  ┌─ Browser ─────────────────────────────────────────────────────────┐
  │  one low-impact risk: silent React leaks from the half-wired       │
  │  AbortController choice (UI side only)                             │
  └─────────────────────────────│─────────────────────────────────────┘
                                │
  ┌─ Vercel function (Node parent) ─▼─────────────────────────────────┐  ← most risks
  │                                                                   │
  │  seam 1: warm-instance vs cold-instance                            │
  │   → process-local state silently empties on instance swap          │
  │                                                                   │
  │  seam 2: client lifecycle vs server lifecycle                      │
  │   → half-wired AbortController; tab close still doesn't stop run   │
  │                                                                   │
  │  seam 3: app vs platform                                           │
  │   → no SIGTERM handler; eviction at maxDuration kills mid-work     │
  │                                                                   │
  │  seam 4 (Phase 2): parent vs Olist child process                   │
  │   → no automatic dispose on parent crash → orphan subprocess       │
  │   → eval scripts can spawn parallel children that clobber          │
  │     shared eval/results/<date>/ output                              │
  └────────────────────────────│──────────────────────────────────────┘
                               │
  ┌─ Providers + Subprocess ───▼──────────────────────────────────────┐
  │  Anthropic + Bloomreach: we honor their bounds — no risks here     │
  │  Olist subprocess: we OWN it now; risks live at the parent seam    │
  └───────────────────────────────────────────────────────────────────┘
```

**Zoom in — how to read this audit.** Each risk has the same shape: **what** (one-line description), **where** (file:line evidence), **likelihood at current scale**, **consequence when it fires**, **the move** (the smallest change that fixes it). No marketing language; no apology; if the choice was deliberate, the deliberateness is named.

---

## Structure pass

**Severity axis:** consequence-when-it-fires (catastrophic / material / observable / cosmetic).

**Likelihood axis:** at the repo's *current* usage (hackathon / portfolio demo). This is honest: a few things ranked "high" here would be "trivial" at FAANG scale because the platform team would have hardened the same seams 100 ways already.

```
  How risks are ranked

  Severity (impact when it fires)    Likelihood (at current scale)
  ──────────────────────────────    ──────────────────────────────
  catastrophic — silent data loss   high     — fires routinely
  material      — wasted spend       medium  — fires on edge cases
  observable    — bad UX              low     — fires under rare load
  cosmetic      — dev annoyance       trivial — measure-don't-fix today
```

**Seams the risks live on (from prior chapters):**

- *Module-scope state on warm-instance lifetime* (`05`) → empty-Map surprises.
- *Run-to-completion as the only synchronization* (`04`) → safe today, fragile to a future `await`.
- *Half-wired `AbortController`* (`07`) → server can't see client disconnect; adapter has its own 30s wall.
- *Sync I/O on the main thread* (`02`, `06`) → blocking lurks if file sizes grow.
- *Subprocess lifecycle ownership* (`02`, `06`) → orphan child if `dispose()` is skipped.
- *`composeSignals` duplication* (`04`) → 10 LOC copy-pasted; cleanup candidate, not a runtime risk.

---

## The ranked risks

### Risk 1 — Process-local state assumes one warm instance forever

**Severity: catastrophic** (silent missing data, looks like a bug to the user)
**Likelihood at current scale: medium-high** (any time Vercel routes a request to a freshly-cold-started instance, which is every deploy, every long idle, every concurrent-load spike)

**What.** Every "state" Map in the repo is module-scope, lives only in the current Node process, and is silently empty on a different warm instance. The user opens the feed on instance A (sees 10 insights), refreshes onto instance B (cold start, sees 0 insights, no error), gets confused.

**Where.**
- `lib/state/insights.ts:4-6` — `insights`, `investigations`, `anomalies` Maps.
- `lib/state/investigations.ts:11` — `mem` Map for cached investigations.
- `lib/mcp/schema.ts:131` — `cached` workspace schema.
- `lib/mcp/client.ts:80` — `McpClient.cache` (per-instance, but also per-McpClient — so per-request — so this one is OK).

The route comment at `app/api/agent/route.ts:35-37` actually flags this risk for one case explicitly: *"Prefers the client-provided insight (handed from the feed via sessionStorage → `?insight=`), which is the only source that survives Vercel's per-instance memory."* This is the only place the repo navigates around it. Everywhere else, the in-memory state is treated as authoritative.

**Consequence when it fires.** Opens an investigation → 404 "insight not found" if the resolveAnomaly path can't fall through to the demo file. For the briefing: empty feed where there were insights seconds ago.

**The move.** Three layers of escalating fix:
1. **Short-term** (zero infra): document the limit. Add a "if you don't see data, click refresh" affordance. Already partly done with the `?insight=` query-param fallback.
2. **Medium-term** (one infra dep): move the `investigations` cache to Vercel KV or Upstash Redis. Drop-in for the Map. Cost: ~$0/mo for low usage.
3. **Long-term** (real DB): the demo-snapshot pattern (committed JSON) plus the in-memory Map is the wrong shape for anything beyond demo. The right shape is "the model output is durable from the moment it's produced," which means saving to a real store inside the agent run.

The right answer right now is move (1) — name the limit honestly in the UI and keep the Map for the demo-warm-instance window.

---

### Risk 2 — Browser→server cancellation is HALF-WIRED — adapter signal exists, route doesn't pass one

**Severity: material** (wasted compute, wasted API spend on abandoned investigations)
**Likelihood at current scale: medium** (every user who opens an investigation and navigates away)

**What.** Phase 2 added `signal?: AbortSignal` to `DataSource.callTool` and wired `AbortSignal.timeout(30_000)` via `composeSignals` inside each adapter (`lib/data-source/olist-data-source.ts:151`, `lib/mcp/transport.ts:131`). So a single hung subprocess or HTTPS call now aborts after 30s. What's STILL missing: the route handler doesn't read `req.signal`, `runAgentLoop` has no `signal` parameter, and `useInvestigation` still doesn't `ac.abort()` on cleanup. So a *tab close* still doesn't stop the run — only a *single hanging tool call* does.

**Where.**
- `lib/hooks/useInvestigation.ts:32-36` — the documented "we don't abort" decision (React StrictMode workaround).
- `app/api/agent/route.ts:170-264` — `start(controller)` callback never checks `req.signal`.
- `app/api/briefing/route.ts:179-256` — same.
- `lib/agents/base.ts:48-176` — `runAgentLoop` has no `signal` plumbing.
- (Good news, anchored:) `lib/data-source/types.ts:38-44` — interface accepts the signal; both adapters already use it.

**Consequence when it fires.** A 100-second investigation costs:
- ~6 Anthropic calls × ~2-15s × per-call tokens = a few cents of Anthropic spend per abandoned run.
- ~6 tool calls (subprocess or Bloomreach) = no monetary cost for the subprocess; real load on Bloomreach.
- ~1 `saveInvestigation` write for an investigation nobody will look at = trivial.

At a few demo users per day, rounding error. At 1000 daily users with a 30% abandon rate, real bill.

**The move (smaller than it was — the hard half is done).**

```
  the wiring that REMAINS (pseudocode)

  // route — read req.signal:
  GET(req) {
    const ac = new AbortController()
    req.signal.addEventListener('abort', () => ac.abort())
    // hand ac.signal to runAgentLoop
  }

  // runAgentLoop — accept and propagate:
  function runAgentLoop({ ..., signal }) {
    await anthropic.messages.create({ ..., signal })       ← SDK supports it
    await dataSource.callTool(name, args, { signal })      ← ALREADY supports it (Phase 2)
  }

  // client — gate the abort on production:
  useEffect(() => {
    const ac = new AbortController()
    fetch(url, { signal: ac.signal })
    return () => {
      if (process.env.NODE_ENV === 'production') ac.abort()  ← keep StrictMode-safe in dev
    }
  })
```

Effort: ~15 lines (was ~30 pre-Phase-2; the adapter half is already there). Payoff: stop paying for abandoned investigations.

---

### Risk 2.5 — No automatic Olist subprocess cleanup on parent crash (Phase 2, new)

**Severity: material** (orphan child processes accumulate; in dev-server long-runs they leak SQLite handles + ~30-50MB each)
**Likelihood at current scale: medium-low** (only triggers when `dispose()` doesn't run — uncaught throws, `maxDuration` SIGKILL, dev-server HMR, ungraceful interrupt of an eval script)

**What.** `OlistDataSource.dispose()` is the only cleanup path that kills the child. If the parent crashes before `dispose()` runs, the child is orphaned. The OS SHOULD send EOF to the child's stdin when the parent dies (closing the parent's half of the pipe), and the child SHOULD exit on EOF — but this isn't guaranteed across all crash modes (especially `kill -9` of the parent, where the OS may take time to garbage-collect the pipe). There's no `process.on('exit', () => ds.dispose())` handler installed anywhere in the repo.

**Where.**
- `lib/data-source/olist-data-source.ts:176-196` — `dispose()` exists but is only called by callers who remember to call it.
- `lib/data-source/index.ts:87` — the factory exposes `dispose` to the route handler; the route is responsible for the `finally`.
- Nowhere: a `process.on('exit')` / `process.on('SIGINT')` / `process.on('SIGTERM')` reaper for in-flight OlistDataSource instances.

**Consequence when it fires.** Each orphaned child holds ~30-50MB of heap + an open SQLite FD. The OS reaps them eventually (parent's pipe FDs are reclaimed by the kernel within seconds-to-minutes), but during long dev sessions with frequent HMR or repeated `npm run eval:*` interrupts, you can accumulate several orphans before noticing. `ps aux | grep mcp-server-olist` is the diagnostic; `kill <pid>` is the cure. The dev-server case is the most painful — each HMR reload of a route module can spawn a new child without disposing the old one if the cleanup discipline isn't enforced at module boundaries.

**The move.**

```
  the safety net (pseudocode)

  // lib/data-source/olist-data-source.ts — add a global registry:
  const liveSources = new Set<OlistDataSource>()
  constructor() {
    liveSources.add(this)
  }
  async dispose() {
    liveSources.delete(this)
    // ... existing cleanup ...
  }

  // module init (once per process):
  if (!globalThis.__olistReaperInstalled) {
    globalThis.__olistReaperInstalled = true
    const reap = () => liveSources.forEach(ds => ds.dispose().catch(() => {}))
    process.on('exit', reap)
    process.on('SIGTERM', reap)
    process.on('SIGINT', reap)
  }
```

Effort: ~15 lines. Caveat: `process.on('exit')` only fires on normal exits; SIGKILL bypasses it. The right belt-and-braces for SIGKILL is to add an `unref()`-style detach + `child.kill()` on parent crash inside the SDK transport — that's an upstream change.

---

### Risk 2.6 — Parallel eval-script runs share filesystem output dirs (Phase 3 anecdote)

**Severity: material** (data corruption: two `eval:diagnosis -- --K=10` runs write to the same `eval/results/<date>/` and one silently overwrites the other)
**Likelihood at current scale: low** (only fires when two sessions/agents trigger the same eval script same day) — but it HAPPENED in PR E development

**What.** During PR E, the main session ran `npm run eval:diagnosis -- --K=10` while a sub-agent (in parallel) ran the SAME script. Both `tsx` processes were detected via `ps aux` and killed (PIDs 30039 and 30040) before either completed; if neither had been killed, the second-finishing one would have clobbered the first's results. The mitigation is `EVAL_RUN_TAG=<suffix>` — sets the output dir to `eval/results/<date>-<tag>/` — but it's opt-in.

**Where.**
- `eval/scripts/run-*.ts` — entry points; default to `eval/results/<date>/` for output.
- `.aipe/study-testing/06-eval-flywheel.md` — the full incident report (PIDs 30039/30040, `ps aux` + `kill`, the lesson).

**Consequence when it fires.** Two parallel runs of the same eval script produce one survivor's results in the shared directory. The metrics for the "lost" run are gone. At low frequency this is a few minutes of wasted Anthropic spend; if it happens during a regression-check that gates a PR, it's a real correctness gap.

**The move.** Add a lockfile check at eval-script entry:

```
  the gate (pseudocode)

  const lockPath = resolve('eval/results', dateStr, '.lock')
  if (existsSync(lockPath) && !process.env.EVAL_RUN_TAG) {
    throw new Error(
      `eval/results/${dateStr}/ is in use by another run. ` +
      `Set EVAL_RUN_TAG=<suffix> to write to eval/results/${dateStr}-<suffix>/ instead.`
    )
  }
  writeFileSync(lockPath, String(process.pid))
  process.on('exit', () => unlinkSync(lockPath))
```

Cheap, mechanical, prevents the next variant of this incident. Same shape as `vi.stubEnv` / `vi.unstubAllEnvs` in the test layer.

---

### Risk 3 — Sync I/O on the main thread (`readFileSync`, `writeFileSync`)

**Severity: observable** (event-loop block freezes concurrent requests)
**Likelihood at current scale: trivial** (the files are tiny; the blocks are sub-millisecond)

**What.** Several routes use `readFileSync` for demo replay and `writeFileSync` for dev-only persistence. Sync file I/O blocks the event loop for the read/write duration. Today the files are ≤100KB and the blocks are imperceptible. If any of those files grew significantly (the demo snapshot picking up more captured investigations, an export feature that wrote per-request artifacts), the same code would freeze every concurrent request on the warm instance for the full I/O duration.

**Where.**
- `app/api/agent/route.ts:53` — `readFileSync(DEMO_FILE, 'utf8')` in `resolveAnomaly`.
- `app/api/briefing/route.ts:87` — `readFileSync(DEMO_FILE, 'utf8')` in the demo replay path.
- `lib/agents/monitoring.ts:13`, `lib/agents/diagnostic.ts:14`, `lib/agents/recommendation.ts:*`, `lib/agents/query.ts:*` — `readFileSync` of prompt markdown at module init (safe — runs once per cold start).
- `lib/state/investigations.ts:30-41` and `lib/mcp/auth.ts:137-141` — `writeFileSync` for dev caches (gated by `NODE_ENV === 'development'`).

**Consequence when it fires.** A request that triggers the read pauses the loop for the duration. Under low load, invisible. Under concurrent load with a 1MB file, every concurrent request would freeze for ~10-20ms — observable but not catastrophic.

**The move.** No-op today. Lever for the future: swap to `fs/promises.readFile` / `writeFile` (the async variants). Cost: zero behavior change at low size, no event-loop block at high size. The prompt-loading reads at module init are fine to leave sync — they only run on cold start.

```
  the swap, where it matters

  readFileSync(DEMO_FILE, 'utf8')       ← blocks loop
      ↓
  await readFile(DEMO_FILE, 'utf8')     ← yields loop on libuv thread pool
```

---

### Risk 4 — `investigations` Map grows monotonically with no eviction

**Severity: observable** (memory bloat → cold-start more often)
**Likelihood at current scale: trivial** (Vercel evicts warm instances long before the Map gets big)

**What.** `lib/state/investigations.ts:11` holds a `Map<string, AgentEvent[]>` that only grows. Every `saveInvestigation` adds an entry; nothing ever removes one. Each entry is ~50KB after the 4KB-per-event truncation. At hackathon scale (tens of investigations per warm instance), single-digit MB total. At sustained scale (thousands per warm instance), hundreds of MB.

**Where.**
- `lib/state/investigations.ts:11, 30-41` — the `mem` Map and the unbounded `set`.

**Consequence when it fires.** As the warm instance accumulates investigations, V8 heap grows. Eventually Vercel evicts the instance for memory pressure → cold starts more often → user-visible latency spike → and the Map empties anyway when the new instance comes up.

**The move.** Drop in an LRU bound when usage justifies it. `lru-cache` is one import:

```
  the swap

  const mem = new Map<string, AgentEvent[]>()
        ↓
  import { LRUCache } from 'lru-cache'
  const mem = new LRUCache<string, AgentEvent[]>({ max: 100 })
```

Behavior change: oldest entries are evicted when the Map fills. Same API surface (`get`, `set`, `has`). Risk: zero — eviction in a cache is fine.

---

### Risk 5 — `cached` schema race-and-bootstrap-twice on cold-start concurrent load

**Severity: observable** (one extra bootstrap = ~5s of duplicated MCP work)
**Likelihood at current scale: low** (requires two concurrent requests landing on a freshly-cold-started instance)

**What.** `lib/mcp/schema.ts:131` holds `let cached: WorkspaceSchema | null = null` at module scope. Two concurrent requests can both find `cached === null` (before either has finished bootstrap) and both run `bootstrapSchema` — 4 sequential tool calls × 1.1s gate = ~5s of duplicated work. The final state is correct (both compute the same schema) so there's no logical bug, just wasted compute on the first concurrent cold burst.

**Where.**
- `lib/mcp/schema.ts:131, 173-192` — the cache-check-then-bootstrap-then-set pattern, with awaits in between.

**Consequence when it fires.** ~5s of extra MCP work spread across two requests. Both still get correct answers. Neither user notices unless they're benchmarking.

**The move.** Memoize the Promise, not the value:

```
  the swap

  let cached: WorkspaceSchema | null = null
        ↓
  let inflight: Promise<WorkspaceSchema> | null = null

  export async function bootstrapSchema(mcp) {
    if (inflight) return inflight      ← second caller waits on the first
    inflight = (async () => {
      // ... 4 calls ...
      return parseWorkspaceSchema(...)
    })()
    return inflight
  }
```

Now the second caller awaits the first one's promise. Cost: a few lines, no behavior change for the user.

---

### Risk 6 — No graceful shutdown on `maxDuration` kill or instance eviction

**Severity: material** (mid-run state is lost; cache is never written; partial UI state)
**Likelihood at current scale: low** (the bounded-work design rarely lets us approach `maxDuration`)

**What.** When Vercel kills the function (because `maxDuration` fired or the platform decided to evict for any other reason), there is no opportunity to flush state. We don't install `process.on('SIGTERM', ...)` (and even if we did, Vercel's documentation is murky on whether/when SIGTERM is delivered before kill). `saveInvestigation` is the only "save" call and it only runs at the natural END of a successful agent run — there's no incremental save.

**Where.**
- `app/api/agent/route.ts:254` — `if (step == null) saveInvestigation(insightId!, collected)` runs ONLY after the agent succeeded.
- `app/api/briefing/route.ts:242-244` — `putInsights` runs only after the scan succeeded.
- Nowhere in the repo: a `process.on('SIGTERM', ...)` handler.

**Consequence when it fires.** A 250-second investigation that hits some hiccup and goes to 305 seconds gets killed mid-loop. The collected events are gone. The user sees a truncated NDJSON body, the client shows an incomplete trace. Refreshing won't get them the partial work back.

**The move.** Two incremental fixes:

1. **Incremental save during the run.** After each major step (diagnosis emitted, each recommendation emitted), call `saveInvestigation(...)` with what's been collected so far. Cost: a few writes per investigation. Payoff: partial work survives a mid-run kill.
2. **A SIGTERM handler** that flushes the in-memory caches to wherever durable storage lives (today, nowhere; tomorrow, KV/Redis). The doc-uncertainty about Vercel's SIGTERM means this is a "nice to have" that might not fire.

The bigger fix is just Risk 1's fix — once the cache moves off-process, the kill mid-run is much less painful because state is already durable.

---

### Risk 7 — Per-request `McpClient` means no cross-request cache reuse on warm instance

**Severity: cosmetic** (wasted MCP roundtrips on consecutive requests for the same data)
**Likelihood at current scale: low** (the bootstrap schema IS shared via module scope; the per-call cache is the small one)

**What.** Every `connectMcp` (`lib/mcp/connect.ts:91-96`) builds a fresh `McpClient`. The `McpClient.cache` Map and `lastCallAt` spacing-gate state are therefore per-request, not per-warm-instance. So if requests A and B both call `get_event_schema` 30 seconds apart on the warm instance, request B doesn't hit a cached result — it re-spaces, re-fetches, re-stores. Within ONE request, the 60s TTL absorbs repeats; across requests, it doesn't help.

**Where.**
- `lib/mcp/connect.ts:91-96` — `new McpClient(new SdkTransport(...), { ... })` per request.

**Consequence when it fires.** Two requests asking for the same MCP data both pay the spacing-gate sleep + the HTTP roundtrip. The bootstrap schema specifically is *also* cached at module scope (`lib/mcp/schema.ts:131`), so the most common case is covered. Other tools are not.

**The move.** Make the `McpClient.cache` module-scope (or `globalThis`-attached) so it survives across requests, while keeping the `lastCallAt` per-request (because the spacing gate is per-call sequence, not per-data-source). Or, simpler, just rely on the schema cache being module-scope and accept that other tools may re-fetch. Today, "accept" is the right call.

---

### Risk 8 — The 1.1s spacing gate doesn't cross requests on one warm instance

**Severity: cosmetic** (occasional rate-limit retry burns a 10s window)
**Likelihood at current scale: low** (depends on concurrent users on the warm instance)

**What.** Because each request has its own `McpClient` (Risk 7), each request has its own `lastCallAt`. Two concurrent requests' first calls can land within the same 1-second window on Bloomreach's side. Bloomreach returns a 429. `McpClient` parses the retry hint and waits ~10s before retrying. That 10s wait is real time spent inside one of those two requests.

**Where.**
- `lib/mcp/connect.ts:91-96` — per-request `McpClient`.
- `lib/mcp/client.ts:122-132` — the retry logic that saves us when this happens.

**Consequence when it fires.** A request takes 10s longer than usual because of one rate-limit retry. User-visible as a slow agent step.

**The move.** Move the spacing gate to a `globalThis.__lastMcpCallAt` (or, more cleanly, a module-scope `McpRateLimitGate` class). This is what the rate-limit-aware comments in `lib/mcp/connect.ts:85-90` are actually justifying — the comment says "the 60s response cache absorbs repeats," which only holds intra-request. Cross-request coordination would require global state. Not done today, and the retry path is the safety net.

---

### Risk 9 — `readFileSync` of prompt markdown at module init is fine; the broader pattern isn't

**Severity: cosmetic** (cold-start latency only)
**Likelihood at current scale: trivial** (runs once per cold start)

**What.** `lib/agents/monitoring.ts:13` reads `lib/agents/prompts/monitoring.md` synchronously at module load. Same pattern in the other agent files. This blocks Node module init for the read duration. The files are small (~few KB each), so the block is sub-millisecond. It runs ONCE per cold start.

**Where.**
- `lib/agents/monitoring.ts:13` — `readFileSync(...)`.
- `lib/agents/diagnostic.ts:14` — same.
- `lib/agents/recommendation.ts` and `lib/agents/query.ts` — same pattern.

**Consequence when it fires.** Cold-start time increases by sub-millisecond. Not measurable.

**The move.** Leave it. Could be `import.meta`-style ESM resolution or a build-time string import; not worth the change. The pattern is honest about being a one-time read.

---

### Risk 10 — Stream backpressure not signaled (`controller.enqueue` without checking `desiredSize`)

**Severity: cosmetic** (unbounded buffer growth if producer outpaces consumer)
**Likelihood at current scale: trivial** (data per event is KB, total per stream is sub-MB, clients drain faster than server produces)

**What.** The route handlers call `controller.enqueue(bytes)` without checking `controller.desiredSize` (which goes negative when the consumer is behind) or waiting for any ready signal. In principle, a fast producer and a slow consumer could let the stream's internal buffer grow unbounded.

**Where.**
- `app/api/agent/route.ts:134, 174-186` — `controller.enqueue(...)` calls.
- `app/api/briefing/route.ts:100, 115-116, 181-185` — same.

**Consequence when it fires.** None today. The data rate (a few events/second, ≤4KB each) is well below any conceivable network bottleneck.

**The move.** No-op today. Lever for the future: a large-payload stream (CSV export, big chart data) would want `if (controller.desiredSize < 0) await something(); controller.enqueue(...)`. WHATWG Streams has the primitives.

---

## Honest about what this codebase doesn't exercise

These would normally appear in a runtime audit but the repo doesn't have the surface, so there's no risk to report:

- **Worker threads / clustering.** Not used.
- **`child_process` via raw `spawn` from app code.** Not used — but `@modelcontextprotocol/sdk`'s `StdioClientTransport` spawns the Olist child under the hood. Risk 2.5 covers the lifecycle gap.
- **CPU-bound work blocking the loop.** Not currently exercised in the parent — every heavy compute is offloaded to providers or the subprocess. The subprocess itself runs sync `better-sqlite3` but is single-flight so its loop block is safe.
- **Locks / Atomics / SharedArrayBuffer.** Not used. The repo's concurrency model (run-to-completion + `AsyncLocalStorage` + single-flight subprocess) is sufficient.
- **`SIGTERM` / `SIGINT` handlers, graceful shutdown.** Not installed in the parent. Risk 2.5 covers the subprocess reaper that should be.
- **`process.exit` / `process.kill` from app code.** Never called.
- **Long-running background jobs / cron.** Not present. No queue, no scheduler.
- **File watching / `fs.watch`.** Not present.
- **Network connection pooling (DB, Redis, etc.).** Not present (no DB). Node's `fetch` handles HTTP keepalive transparently for the provider calls.

---

## How I'd prioritize the fixes

If you handed me a one-day budget and said "harden the runtime":

```
  one-day fix priority (Phase 2)

  ┌─ ship it (high payoff, low effort) ──────────────────────────┐
  │  1. Risk 2.5 — install a SIGTERM/SIGINT/exit reaper for       │
  │     live OlistDataSource instances                             │
  │     ~15 lines; closes the orphan-child gap                     │
  │  2. Risk 2 — finish wiring AbortController (route → loop →    │
  │     adapter; adapter half is already done)                    │
  │     ~15 lines; stops paying for abandoned investigations       │
  │  3. Risk 2.6 — add a lockfile check at eval-script entry      │
  │     ~10 lines; prevents the next parallel-run clobber          │
  │  4. Risk 5 — Promise-cache the schema bootstrap                │
  │     ~10 lines; eliminates the cold-burst duplicate work       │
  │  5. Risk 4 — LRU-cache the investigations Map                  │
  │     ~5 lines; bounds memory growth as a side benefit          │
  │  6. Cleanup: promote composeSignals to lib/runtime/signals.ts │
  │     and import from both call sites                            │
  │     ~5 LOC moved + 2 imports; zero behavior change             │
  └───────────────────────────────────────────────────────────────┘
  ┌─ measure first (could matter, could not) ────────────────────┐
  │  7. Risk 8 — move spacing gate to module scope                │
  │     measure rate-limit retry frequency in production first    │
  │     before doing the global-state refactor                    │
  └───────────────────────────────────────────────────────────────┘
  ┌─ defer (right answer is bigger than the symptom) ────────────┐
  │  8. Risk 1 — process-local state on serverless                │
  │     right answer is a real durable store (KV/Redis/DB),       │
  │     not a patch on the Map                                    │
  │  9. Risk 6 — incremental save / SIGTERM for the parent        │
  │     subsumed by Risk 1's fix                                  │
  └───────────────────────────────────────────────────────────────┘
  ┌─ name and leave (no current cost) ───────────────────────────┐
  │  Risk 3, 7, 9, 10 — sync I/O, per-request McpClient,          │
  │  module-init reads, backpressure                              │
  │  document the levers; don't pull them without a trigger       │
  └───────────────────────────────────────────────────────────────┘
```

---

## See also

- `00-overview.md` — top-3 risks in the overview map onto Risks 2.5, 1, 2 here (Phase 2 re-ranked).
- `01-runtime-map.md` — the runtime topology (four bands) that makes the risks make sense.
- `04-shared-state-races-and-synchronization.md` — Risk 5's race; composeSignals duplication.
- `05-memory-stack-heap-gc-and-lifetimes.md` — Risks 1, 4, 7 are all lifetime risks; child-heap section.
- `06-filesystem-streams-and-resource-lifecycle.md` — Risk 2.5 (orphan child) lives here as a resource-cleanup story.
- `07-backpressure-bounded-work-and-cancellation.md` — Risk 2 (half-wired AbortController) is the cancellation half; Risk 10 is backpressure.
- `.aipe/study-testing/06-eval-flywheel.md` — full incident report for Risk 2.6 (parallel K=10 clobber).

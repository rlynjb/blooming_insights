# audit.md — the 8-lens performance walk

Each lens either names what the codebase actually does (with
`file:line` grounding) or emits `not yet exercised`. Cross-links
to Pass 2 pattern files where the finding warrants a deep walk.

---

## 1. performance-budget — the user-visible and system-visible budget

**What exists.** The system carries three composed budgets:

  → **Route budget: 300s** — `app/api/agent/route.ts:23` and
    `app/api/briefing/route.ts:20` both `export const maxDuration = 300`.
    The Vercel Pro upper bound, chosen because a live investigation
    runs ~100–115s under the ~1 req/s MCP limit and 60s (Vercel
    Hobby) can't fit it. Comment at `route.ts:21-22` names the
    tradeoff explicitly.

  → **Per-tool timeout: 30s** — `lib/mcp/transport.ts:38`
    `TOOL_TIMEOUT_MS = 30_000`. `AbortSignal.timeout(TOOL_TIMEOUT_MS)`
    composes with the request-level `signal` so the first to fire
    wins (`transport.ts:131,150`).

  → **Per-investigation cost ceiling: $2 default** — `eval/load.eval.ts:91`
    `BUDGET_PER_INVESTIGATION_USD = Number(process.env.BUDGET_MAX_USD ?? '2.0')`.
    Enforced by the `BudgetTracker` gate at `lib/agents/aptkit-adapters.ts:64-66`
    — thrown BEFORE the next model turn dispatches. See
    `05-budget-ceiling-check-before-dispatch.md`.

**How the three compose.** The route budget bounds the outer wall
clock. The tool timeout bounds any single call so a stuck MCP tool
can't blow the whole route. The cost ceiling bounds spend across
turns so a runaway ReAct loop can't burn dollars. Each is a
different axis (time / call / money) — they don't substitute for
each other.

**Full walk:** `01-route-budget-and-timeout-composition.md`.

---

## 2. measurement-baselines-and-profiling — representative workloads, baselines, profilers

**Baseline exists and is checked in.** `eval/baseline.json` records
runId `2026-07-03T04-08-28-644Z`, 10 cases, per-dimension pass rates
per phase. It's the reference the gate eval compares against:
`eval/gate.eval.ts` reads baseline and enforces a delta ceiling.

**Per-request phase timings recorded.** `app/api/agent/route.ts:220-224`:

```
  const t0 = performance.now();
  const phases: Array<{ phase: string; durationMs: number }> = [];
  const recordPhase = (phase: string, started: number) => {
    phases.push({ phase, durationMs: Math.round(performance.now() - started) });
  };
```

Every phase (`schema_bootstrap`, `list_tools`, `intent_classify`,
`diagnostic_investigate`, `recommendation_propose`) records a
duration and one JSON line is emitted at request end
(`route.ts:336-343`). Vercel's log query picks up the shape.
The `finally` guarantees the log fires even when a phase throws —
important for the 300s-budget incident signal.

**Load harness produces per-run receipts.** `eval/load-receipts/`
holds `load-<runId>.json` with `percentilesMs.total|investigate|recommend`
p50/p95/p99, cost distributions, and per-investigation records.
Latest receipt (2026-07-03T05-21-12-237Z, N=3 with faults):
p50 total 92.7s, p95 99.6s, cost total $0.209. See
`06-load-harness-semaphore-concurrency.md`.

**Not yet exercised.** No CPU or memory profiling. No flamegraphs,
no heap snapshots, no Node `--prof`, no Chrome DevTools capture
checked in. Given the hot path is network-bound (Anthropic + MCP),
this is a defensible gap for now — becomes relevant when the client
gets a heavier react tree or when a background worker joins.

**Not yet exercised.** No frontend perf baseline. No Lighthouse
run, no Core Web Vitals capture, no bundle-size budget in CI.

---

## 3. latency-throughput-and-tail-behavior — distributions, p95/p99, queues, contention

**Distributions measured.** The load receipt's `percentilesMs`
block reports `{p50, p95, p99, max, mean}` per phase (see receipt
snippet at `eval/load.eval.ts:326-333` `percentiles(...)`
implementation). Baseline receipts also record per-case wall
clock:

```
  case                                p50 total (ms)
  01-conversion-drop-mobile-checkout  218,782
  09-recommendation-outlier           ~675,000  ← tail
```

Case 09 rec-judge at 675s is the named outlier. That's the tail
worth defending — not because the p50 hides it, but because a
p95/p99 without a max is a lie. The load receipt reports max
alongside p99.

**Contention model — semaphore not queue.** `eval/load.eval.ts:170-211`
uses a fixed-K worker pool pulling from a shared `queue` array.
K workers dequeue via `queue.shift()`; work items are indices
into `goldens`. No priority, no fair scheduling — first come,
first served. Bounded parallelism, no unbounded fan-out. See
`06-load-harness-semaphore-concurrency.md`.

**Not yet exercised.** No tail-amplification measurement at scale
(fan-out to many downstream tools where p99 dominates). The
investigations issue a modest handful of tool calls; the
tail-amplification math doesn't bite.

**Not yet exercised.** No live production p99 vs load-eval p99
comparison. The load eval runs against `SyntheticDataSource`
(0ms tool time by design — `bloomreach-data-source.ts:36` comment
notes `durationMs: 0` on synthetic and cache hits), so its
distribution reflects model latency + agent overhead only, not
MCP network time. Named so the tail number isn't overclaimed.

---

## 4. cpu-memory-and-allocation — CPU cost, allocation, GC, retention

**Response cache is bounded by TTL, not size.**
`lib/data-source/bloomreach-data-source.ts:122`
`private cache = new Map<string, { result: unknown; expiresAt: number }>();`
Every 60s entries expire on read (`ttl` check at `:149`); expired
entries are not evicted proactively. For a single request handling
tens of tool calls this is fine — the map stays small. Under
sustained load in a hot instance it can grow before Vercel recycles
the process. Named as a known bound.

**Session state is per-instance.** `lib/state/insights.ts`,
`lib/state/investigations.ts` (referenced from route) hold data in
in-process maps. Vercel serverless can't guarantee the same
instance handles the next request — the comment at `route.ts:34-35`
names this: "the only source that survives Vercel's per-instance
memory."

**Config header adds O(1) work per streaming fetch** (Session D
addition, minor perf touch): client encodes via
`readPersistedConfig` → `JSON.stringify` → `btoa`
(`lib/mcp/config.ts:77-82,142-146`); server decodes via `atob` →
`JSON.parse` → `isMcpConfigOverride` guard
(`lib/mcp/config.ts:87-100`). Both are O(1) in config size and
negligible relative to model-call latency. Base64 (not hex or
url-safe base64) is intentional so future unicode URLs travel
safely — comment at `config.ts:75-76` names the tradeoff.

**Not yet exercised.** No heap snapshot, no allocation profile,
no GC-pressure measurement. The workload is I/O-bound, so
allocation cost is dominated by network payload parsing (already
efficient) — this hasn't been the bottleneck.

---

## 5. io-network-and-database-bottlenecks — filesystem, network, API, DB

**The dominant bottleneck is the MCP call latency + rate limit.**
Bloomreach rate-limits per user globally, states the window in the
error text, and observed windows are `(1 per 1 second)` and
`(1 per 10 second)` — see extended comment at
`lib/mcp/connect.ts:110-117`. Two mechanisms hold the line:

  → **Proactive spacing at 1.1s.** `lib/mcp/connect.ts:121`
    `minIntervalMs: 1100`. Enforced by `lib/data-source/bloomreach-data-source.ts:190-194`:

    ```
    const elapsed = Date.now() - this.lastCallAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }
    ```

  → **Reactive retry ladder.** `bloomreach-data-source.ts:163-174`:
    parses `Retry-after ~12 second(s)` or `per 10 second` out of
    the 429 error text; falls back to exponential backoff off
    `retryDelayMs = 10_000`; capped at `retryCeilingMs = 20_000`.

**These are different mechanisms, not two settings of the same
one.** Spacing is a scheduler applied to every call proactively.
The retry ladder is backpressure — reactive, only fires on a 429.
That distinction is the load-bearing teaching point of the whole
perf story. See `02-spacing-gate-and-retry-ladder.md`.

**Response cache absorbs repeats.** `bloomreach-data-source.ts:145`
`ttl = options.cacheTtlMs ?? 60_000`; per `(name, args)` key at
`:144`. Errors are not cached (`:179`) — otherwise a transient
failure would poison the next 60s. Skip-cache still writes through
(`:183-186`) so a `/debug` "force fresh" call refreshes the entry.
See `04-response-cache-ttl.md`.

**Prompt caching lives at the model-call boundary.**
`lib/agents/aptkit-adapters.ts:85-89` wraps the system prompt in
`cache_control: { type: 'ephemeral' }`. Anthropic returns
`cache_read_input_tokens` on cache hit — validated live in the
receipts (3168 tokens on the second turn of a diagnostic run).
Roughly 80% off system-prompt cost across a 10-turn loop. See
`03-prompt-caching-ephemeral-breakpoint.md`.

**Not yet exercised.** No database. The demo insights load from
`lib/state/demo-insights.json` on disk (route `:25` `DEMO_FILE`),
which is a one-shot read per request. No connection pool, no
query planner, no index tuning — because there is no DB.

---

## 6. caching-batching-and-backpressure — cache tradeoffs, throttling, bounded work, overload

**Caches, in layers:**

  1. **Response cache** — per-instance, 60s TTL, per `(name, args)`.
     `bloomreach-data-source.ts:122,145`. Absorbs repeats within an
     investigation; empty on cold start; not shared across Vercel
     instances. Correct-enough for portfolio traffic.
     → `04-response-cache-ttl.md`.

  2. **Prompt cache** — Anthropic-side ephemeral breakpoint at the
     system prompt, 5-min TTL server-side. `aptkit-adapters.ts:85-89`.
     Client sends the breakpoint; server tracks. Cache-read cost
     is roughly 0.1× normal input cost.
     → `03-prompt-caching-ephemeral-breakpoint.md`.

  3. **Investigation replay cache** — `lib/state/investigations.ts`
     via `saveInvestigation`/`getCachedInvestigation` (imported at
     route `:17`). Combined-run outputs are saved to disk so
     `/investigate?insight=…` (without `&live=1`) replays events
     instead of re-running agents. Replay delay `REPLAY_DELAY_MS = 180`
     at `route.ts:104` (agent) and `140` (briefing) paces the
     stream so the UI can render each event visibly.

**Backpressure — the spacing gate vs the retry ladder.**
The two mechanisms in §5. Named again here under this lens because
they are the repo's core backpressure story: spacing is prevention;
retry is recovery. See `02-spacing-gate-and-retry-ladder.md`.

**Batching — not exercised.** No tool-call batching. Every model
turn decides one tool at a time (ReAct loop shape). This is
intentional — the agent reasoning depends on seeing each tool
result before choosing the next call.

**Bounded work — the load harness.** `eval/load.eval.ts:210`
`workers = Array.from({ length: LOAD_CONCURRENCY }, ...)` bounds
in-flight investigations at a fixed K. No unbounded `Promise.all`
over `LOAD_N` items; that's the anti-pattern this guards against.
→ `06-load-harness-semaphore-concurrency.md`.

**Budget-ceiling as overload control.** `BudgetTracker.exceeded()`
checked BEFORE dispatch at `aptkit-adapters.ts:64-66`; throws
`BudgetExceededError` which propagates to the route's error path.
A ReAct loop stuck in a re-plan cycle can't burn additional dollars.
→ `05-budget-ceiling-check-before-dispatch.md`.

---

## 7. rendering-client-and-mobile-performance — bundles, startup, main-thread work

**Streaming NDJSON keeps the UI responsive.** `lib/streaming/ndjson.ts`
reads one event per line, dispatches to `onEvent`. Consumers
(`lib/hooks/useInvestigation.ts`, `lib/hooks/useBriefingStream.ts`)
call `setState` per event so React reconciles incrementally — no
one big render at the end. `cancelOn` polls between reads so an
unmounted consumer cancels the reader cleanly (`ndjson.ts:33-36`).

**React StrictMode-safe fetch guard.** `useInvestigation.ts:46-48`:

```
  if (startedRef.current) return; // run once per mount
  startedRef.current = true;
```

Comment at `:31-37` explains why: StrictMode dev mounts twice; the
guard prevents a double fetch and the in-flight run completes if
the first mount unmounts. `setState` after unmount is a safe no-op
(React swallows it).

**No React perf primitives yet.** `grep useMemo|useCallback|memo(`
across `components/investigation` and `components/feed`: zero hits.
The reasoning trace list can grow to tens of items during a live
run — each `setItems` triggers a re-render of the whole list.
For portfolio-scale traffic this is fine; it's a real perf lever
if the list grows to hundreds of items.

**Not yet exercised.** No Lighthouse baseline, no `next build`
bundle analysis checked in, no Core Web Vitals metric captured,
no LCP/CLS/INP measurement. The client surface is small and
static enough that this hasn't hit yet; named honestly.

**Not yet exercised.** No mobile testing. The app runs in a
desktop browser context for the portfolio narrative.

---

## 8. performance-red-flags-audit — ranked risks with baseline or missing measurement

Risks ordered by consequence. Each names either the baseline that
would catch it or the measurement that's honestly missing.

  ### R1 · 300s route budget can still be breached under stacked latency

  The route budget is 300s. A live diagnostic under bad Bloomreach
  rate limiting could hit: `list_tools` + `bootstrap` (~5s) +
  6 model turns × ~40s (~240s) + retry ladder waits (up to
  20s × 3 = 60s) = ~305s. Baseline p50 is ~225s per full case, so
  headroom is thin.

    → Evidence: `eval/baseline.json` runId 2026-07-03T04-08-28-644Z,
      per-case p50 total 218,782ms.
    → Guard: BudgetTracker throws BEFORE the next dispatch — one
      way the wall-clock cap is respected even when latency stacks.
      See `05-budget-ceiling-check-before-dispatch.md`.
    → Missing measurement: no live p99 for the diagnostic phase
      under rate limit. Live case counts are 10; not enough to
      compute p99 with confidence.

  ### R2 · Recommendation-judge tail — case 09 at 675s

  One rec-judge case at 675s vs a p50 of ~90s (baseline receipt).
  This is a single-case outlier, but a p99 without max hides it.
  The judge runs offline (in eval), so this is a cost/time tail
  in CI, not a live-user tail.

    → Evidence: baseline runId 2026-07-03T04-08-28-644Z, case 09
      recommendationJudge durationMs.
    → Guard: none in the judge path; there's no per-judge timeout.
      The eval runner's per-test timeout (`Math.max(600_000, ...)` at
      `eval/load.eval.ts:228`) catches only pathological hangs.
    → Missing measurement: no distribution of judge-turn latency
      by rubric complexity. Case 09's judge was long because the
      recommendation had many actions; that correlation isn't
      captured in the receipt today.

  ### R3 · Per-instance response cache means cold-start amplification

  The 60s response cache is a per-process `Map`
  (`bloomreach-data-source.ts:122`). A cold Vercel instance starts
  with an empty cache — so the first request pays every tool-call
  latency, and the ~1.1s spacing gate stretches accordingly.
  Steady-state within one warm instance amortizes.

    → Evidence: `bloomreach-data-source.ts:122` (per-instance Map),
      route comment at `route.ts:34-35` (per-instance memory).
    → Guard: prompt cache also has a 5-min TTL server-side, so a
      warm instance survives quiet periods better than a cold one.
    → Missing measurement: no cold-start vs warm-start comparison.
      Would need to force cold start (deploy or wait out the idle
      timeout) and compare first-request phase timings.

  ### R4 · No frontend perf baseline

  The client surface is small today but there's no floor set.
  If the reasoning trace list grows or the feed hits many items,
  main-thread re-render cost climbs silently.

    → Evidence: `grep useMemo|useCallback|memo(` across
      `components/investigation` and `components/feed` returns
      zero — no memoization primitives applied.
    → Guard: none currently.
    → Missing measurement: Lighthouse baseline, `next build` bundle
      analyzer output, LCP/CLS/INP capture from a real page load.
      Any of these three would set the floor.

  ### R5 · Load harness runs synthetic — live tail unknown at scale

  `eval/load.eval.ts:246` uses `new SyntheticDataSource()`. The
  synthetic data source returns `durationMs: 0` (see comment at
  `bloomreach-data-source.ts:36`) — no network time. So the load
  receipt's p95/p99 reflect model latency + agent overhead only.
  Real MCP latency, retries, and 429 waits are not measured under
  load.

    → Evidence: `eval/load.eval.ts:246` (`SyntheticDataSource`);
      `load-receipts/load-2026-07-03T05-21-12-237Z.json` p50 total
      92.7s (fast because no MCP time).
    → Guard: fault-injection layer (`FaultInjectingDataSource`) can
      simulate timeouts and rate limits — so the tail-under-failure
      story IS defensible. See `07-fault-injecting-decorator.md`.
    → Missing measurement: no live-MCP load run. Would burn the
      ~1 req/s Bloomreach budget quickly, so this is a
      known-and-accepted gap for portfolio use.

  ### R6 · No cross-instance cache means fan-out repeats work

  If two Vercel instances handle two adjacent requests for the same
  insight, they run the tool calls twice — nothing is shared. For
  the current traffic profile this is invisible; at any scale it's
  a straightforward Redis/upstash lift.

    → Evidence: `bloomreach-data-source.ts:122` (per-process `Map`).
    → Guard: none.
    → Missing measurement: request-level duplicate detection — a
      count of tool calls with identical `(name, args)` across
      requests would surface how often this matters.

---

## Summary — the shape of this repo's perf story

The perf design is coherent and honest. Three budgets compose
(300s route, 30s tool, ~$2 investigation); two mechanisms guard
the MCP boundary (spacing gate + retry ladder); two caches absorb
repeats (response cache + prompt cache); one gate guards spend
(BudgetTracker checks before dispatch); one harness measures under
bounded parallel load; one decorator exercises graceful degradation.

The gaps are named honestly: no CPU/memory profiling (I/O-bound
workload), no frontend perf baseline (small client surface), no
live-load tail (would burn the rate-limit budget), no cross-instance
cache (unnecessary for portfolio scale). Each gap has a "when it
becomes relevant" answer, which is the point of naming rather than
inventing.

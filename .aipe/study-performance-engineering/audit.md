# Performance engineering — audit

> **Verdict-first:** blooming insights is bounded by **three measurable ceilings and one partially-measured cost line**. The ceilings: `maxDuration = 300s` per route (`app/api/agent/route.ts:20`, `app/api/briefing/route.ts:17`), `minIntervalMs = 1100` Bloomreach spacing (`lib/mcp/connect.ts:92`), and per-agent `maxToolCalls` (6/6/6/4). The partially-measured cost line: the `synthesize()` fallback in `lib/agents/diagnostic.ts:87-126` and `lib/agents/recommendation.ts:82-132` — output-token-heavy structured JSON output that fires whenever the loop fails to emit valid JSON; **3 of 5 Anthropic call sites now log `res.usage`** (`lib/agents/base.ts:135` runAgentLoop, `base.ts:257` runRecoveryTurn, `intent.ts:36` intent classifier — added since 2026-06-02), but `diagnostic.ts:87-126` and `recommendation.ts:82-132` synthesize() retries still don't. The strongest pattern in the codebase is the 60s TTL cache that bypasses both spacing and network on a hit — now at `lib/data-source/bloomreach-data-source.ts:122,144-148` after the Phase 2 PR A seam extraction (`lib/mcp/client.ts` is now a 17-line backwards-compat shim). New ceiling on the eval side: ~$10-15 total Anthropic spend across all 4 Phase 3 eval pillars (detection/diagnosis/recommendation/regression) — first real per-investigation cost number the codebase has. Top finding: complete the meter (add `console.log` to the 2 remaining synthesize() call sites) so the cost-concentration story closes, then assess whether `synthesize()` is genuinely dominant.

## performance-budget

blooming insights ships **four hard budgets** and **zero soft budgets**. The four:

- **Route ceiling.** `maxDuration = 300` at `app/api/agent/route.ts:20` and `app/api/briefing/route.ts:17`. Pinned at Vercel Pro's max. The comment names the rationale: "A live investigation runs ~100-115s under the ~1 req/s MCP limit; 60s (Hobby) cannot fit it."
- **Per-agent tool-call cap.** `maxToolCalls = 6` (monitoring `lib/agents/monitoring.ts:101`, diagnostic `lib/agents/diagnostic.ts:62`, query `lib/agents/query.ts:41`), `4` (recommendation `lib/agents/recommendation.ts:57`). Triggers forced synthesis when hit (`lib/agents/base.ts:88-101`).
- **Tool-result context cap.** `MAX_TOOL_RESULT_CHARS = 16_000` (`lib/agents/base.ts:29`) for the model's context; a tighter `TRUNC = 4000` (`app/api/agent/route.ts:99-103`) for the UI event stream. Same pattern, two consumers, two budgets.
- **Per-call latency floor.** `minIntervalMs = 1100` (`lib/mcp/connect.ts:92`) enforced as a sleep before every MCP call. This is a floor, not a cap.

What's **not codified**: no p95 latency SLO, no error-rate budget, no cost-per-investigation cap. All four hard budgets work because the next layer up enforces them (Vercel kills, the loop counts, truncate clips, the sleep sleeps). The three missing soft budgets need a meter that doesn't exist.

→ see `01-300s-vercel-budget-as-hard-ceiling.md` for the deep walk on the route-budget contract (set-by-judgment, zero headroom, architectural cost of lifting it)

## measurement-baselines-and-profiling

blooming insights measures **one number** today: per-tool-call duration, emitted as `tool_call_end.durationMs` on the NDJSON event stream (`lib/mcp/events.ts:7`, captured at `lib/mcp/client.ts:112,134`). It's *displayed* in the UI's status panel and *never persisted* — every refresh wipes the history. A baseline ("a typical investigation takes 100-115s") exists only as a *comment* in `app/api/agent/route.ts:18-19`.

The cheapest unread meter was `res.usage` returned by every `anthropic.messages.create` call. **PARTIALLY RESOLVED as of 2026-06-15**: 3 of 5 sites now log it (`lib/agents/base.ts:135` runAgentLoop's main turn, `base.ts:257` runRecoveryTurn, `lib/agents/intent.ts:36` intent classifier). The two remaining sites are the synthesize() fallback Anthropic calls inside `lib/agents/diagnostic.ts:87-126` and `lib/agents/recommendation.ts:82-132` — exactly the call sites the cost-concentration finding suspects of dominating. Closing those two completes the meter and unblocks the cost-concentration confirmation.

**New measured data point (Phase 3, 2026-06-15):** ~$10-15 total Anthropic spend across all 4 eval pillars (detection + diagnosis + recommendation + regression) running K=10 per anomaly × 3 seeded anomalies. Recommendation eval alone: 34:50 runtime for K=10 across 3 anomalies. This is the first real "what does an end-to-end investigation cost" data the codebase has — though it's measured against `OlistDataSource` (hermetic SQLite), not the production Bloomreach path. The 30s `AbortSignal.timeout(30_000)` added on the Olist side at `lib/data-source/olist-data-source.ts:151` is the first per-call timeout in the codebase (Bloomreach side still has no per-call timeout — asymmetric coverage).

**Parallel-execution incident (real perf anecdote, 2026-06-15):** K=10 eval was kicked off twice in parallel during Phase 3 PR E — main session ran K=10 from Bash while a sub-agent ALSO ran K=10. Detected via `ps aux`; killed PIDs 30039/30040 before they overwrote results. Mitigation: `EVAL_RUN_TAG` env var added for result-dir namespace separation. The eval suite is now the codebase's first concrete "parallel runs of the same expensive operation will collide" experience.

What's still `not yet exercised`:
- Load testing (no k6, no autocannon, no synthetic baseline)
- Profiler integration (no clinic, no 0x, no `--inspect`)
- Per-investigation summary (the `collected: AgentEvent[]` array at `app/api/agent/route.ts:171` has the inputs but never aggregates)
- APM / Sentry / Datadog
- Web Vitals (no `useReportWebVitals`, no Vercel Speed Insights)
- No per-call timeout on Bloomreach side (only on Olist side)

→ see `04-synthesize-as-cost-concentration.md` for the deep walk on the dominant unmeasured cost line and why the meter is load-bearing

## latency-throughput-and-tail-behavior

A typical live investigation runs **~100-115s** end-to-end (per the comment at `app/api/agent/route.ts:18-19`). It's the sum of three serialized waits: ~6.6s of MCP spacing per agent (6 calls × 1100ms), ~3-10s of Anthropic latency per turn (up to 8 turns × 2 agents), and any rate-limit retry waits (up to 20s each, capped at 3 retries per call by `lib/mcp/client.ts:121-132`).

**Throughput** per user is `1 / latency` ≈ 0.01 inv/sec ≈ 36/hour. Bloomreach's ~1 req/s/user GLOBAL rate cap IS the throughput ceiling; there's no batching, no parallelism (neither Bloomreach MCP nor Anthropic's `messages` API expose batch endpoints).

**The tail** (p99) is not measured. Its shape is knowable from the retry math: 2 calls × 3 retries × 20s = +120s on top of the typical ~100s, which can scrape against the 300s route ceiling. When the tail crosses 300s, Vercel kills the function and the user sees a half-stream.

The serial chain (bootstrap → diagnostic → recommendation, `app/api/agent/route.ts:231-249`) is causally chained — recommendation needs the diagnosis as input, so no `Promise.all` is possible.

## cpu-memory-and-allocation

**I/O-bound, not CPU-bound.** The dominant CPU work is `JSON.stringify` on tool results (`lib/agents/base.ts:150`, `lib/mcp/client.ts:102`) and the truncate function clipping at 16k chars. Per-investigation CPU is single-digit seconds across ~100s of wall-clock — ~100:1 wait-to-CPU ratio. No profiler is integrated; the CPU hot path is inferred from code shape, not measured.

**Three memory shapes**, all bounded:

- **Per-request.** The `messages: MessageParam[]` in `runAgentLoop` (`lib/agents/base.ts:79`) grows by 2 entries per turn, bounded by `maxTurns = 8`. Peak ~256KB per agent. Released at function return.
- **Per-instance.** The in-memory `Map`s in `lib/state/insights.ts:4` (cleared at every `putInsights` via `.clear()` at `:36`) and `lib/state/investigations.ts:11` (no `.delete` — grows monotonically in a warm instance). Schema cache at `lib/mcp/schema.ts:131` — single-slot, ~30-100KB, lives until instance cools.
- **Per-deploy.** `readFileSync`'d prompts (`lib/agents/diagnostic.ts:14`, `monitoring.ts:13`, `recommendation.ts:14`, `query.ts:13`) — few KB each, held for deploy lifetime.

The one **unbounded growth path**: `investigations.set(id, events)` at `lib/state/investigations.ts:31` — no LRU, no eviction. De-facto bound is instance death. For demo scale fine; the shape is the classic Node leak pattern that bites when traffic patterns change.

## io-network-and-database-bottlenecks

Two outbound HTTPS destinations, one outbound stream, **no database**:

- **Outbound HTTPS to Bloomreach MCP** (the bottleneck). `StreamableHTTPClientTransport` (`lib/mcp/connect.ts:71`). ~10-15 calls per investigation × ~1.5-3s each (spacing + network + EQL server time). Rate cap: ~1 req/s/user GLOBAL.
- **Outbound HTTPS to Anthropic** (the variance source). `anthropic.messages.create` at 4 call sites. ~8-16 calls per investigation × ~3-10s each. No upper bound from the contract.
- **Outbound NDJSON streaming.** `ReadableStream<Uint8Array>` via `controller.enqueue` — one line per event, ~100-200 events per investigation. `Cache-Control: no-cache, no-transform` prevents intermediary buffering.
- **Filesystem.** `readFileSync` for prompts at module load (cold-start cost, ~10-20ms). Demo snapshot reads on `?demo=cached`. Dev-mode `writeFileSync` to `.investigation-cache.json` and `.auth-cache.json` (guarded by `PERSIST = process.env.NODE_ENV === 'development'`); serverless FS is read-only so this is a no-op in prod.

Time attribution per typical investigation: Bloomreach ~25%, Anthropic ~60%, NDJSON ~0%, FS ~0%, DB 0% (does not exist). Bloomreach is the *structural* bottleneck (caps throughput); Anthropic owns the *minutes spent*.

The deliberate absence of a database is the load-bearing architectural choice — cross-link to `study-system-design/audit.md#storage-choice-and-durability-boundaries`. It buys deploy simplicity + zero state-op latency; it costs durability + cross-instance consistency.

## caching-batching-and-backpressure

**Two real caches plus one persistence-as-cache layer.** No batching opportunity. No backpressure (the spacing gate looks like it but isn't).

- **TTL cache (60s, exact-match).** Code moved during Phase 2 PR A — now at `lib/data-source/bloomreach-data-source.ts:122,144-148` (was `lib/mcp/client.ts`; the old path is a 17-line backwards-compat shim). Keyed on `${name}:${JSON.stringify(args)}`. On a hit: `durationMs: 0, fromCache: true` — bypasses both spacing gate AND network. Errors are NOT cached — a rate-limit error would otherwise poison the cache for 60s; bypassing caching for errors lets the next call retry immediately after spacing.
- **Schema cache (per-instance, no TTL).** `let cached: WorkspaceSchema | null = null` at `lib/mcp/schema.ts:131`. Populated on first `bootstrapSchema` call (~6-12s), reused forever (until instance death). Saves the bootstrap cost per warm request.
- **Investigation replay store.** `mem: Map<string, AgentEvent[]>` at `lib/state/investigations.ts:11`. Three-source fallback: in-memory → dev cache file → committed demo JSON. This is *replay/persistence*, not a perf cache — a live re-run would produce different events.

**Batching:** `not yet exercised`. Bloomreach MCP exposes no batch endpoint; Anthropic's `messages` is one-turn-per-call. The cache is the equivalent lever — remove the call entirely.

**Backpressure:** `not yet exercised`. The spacing gate (`lib/mcp/client.ts:148-152`) sleeps `minIntervalMs - elapsed` before every call. Same code shape as throttling/backpressure, opposite semantic: it's **rate-limit compliance** (deterministic, fires every call, no queue, no signal). Backpressure needs a queue with depth and an upward signal — neither exists because there's no fan-out. Becomes necessary IF parallel-agent topology ever ships. Cross-link `study-agent-architecture/05-production-serving/02-fan-out-backpressure.md`.

**Prompt-prefix caching** (Anthropic feature): `not yet exercised`. The 5-10KB system prompts are re-tokenized every turn. Adding `cache_control: { type: 'ephemeral' }` is the cheap shrink lever; cross-link `study-ai-engineering/06-production-serving/01-llm-caching.md`.

→ see `02-ttl-cache-with-no-cache-on-error.md` for the deep walk on the cache mechanics
→ see `03-spacing-gate-as-rate-limit-compliance.md` for the compliance-vs-backpressure distinction

## rendering-client-and-mobile-performance

The strategy is **"hide the latency, don't fight it"** — applied perceived-performance design without measured validation.

Four UX moves convert ~100s of actual latency into ~1-2s of time-to-feedback:

- **NDJSON streaming.** `useInvestigation` hook (`lib/hooks/useInvestigation.ts:184-208`) reads chunks via `response.body.getReader()`, splits on `\n`, dispatches per-event. Server-side `ReadableStream` (`app/api/agent/route.ts:167-264`, `app/api/briefing/route.ts:178-258`) with `Cache-Control: no-cache, no-transform` to prevent intermediary buffering.
- **Skeleton placeholders.** `components/shared/Skeleton.tsx`, `components/investigation/RecommendationCardSkeleton.tsx`, `CoverageGrid` loading prop. Match real-content dimensions to prevent layout shift.
- **ProcessStepper.** `components/shared/ProcessStepper.tsx` — three steps (monitoring → diagnostic → recommendation) with `pending | active | complete | error` states. Active step has `animate-pulse`.
- **StatusLog.** `components/shared/StatusLog.tsx` — live agent thoughts + tool calls with durations. `replaceRunningTool` (`useInvestigation.ts:86-95`) updates a tool entry in place when its duration arrives.

**What's not measured:** no Web Vitals (LCP/INP/CLS), no Vercel Speed Insights, no React Profiler integration, no `@next/bundle-analyzer`, no time-to-first-event / time-to-diagnosis metrics. Same gap as `measurement-baselines-and-profiling` — applied without validation.

**Per-event setState (`useInvestigation.ts:97-150`)** is not batched — fine at today's ~1-2 events/sec, would dominate render time at higher rates (e.g. streamed text-deltas).

Mobile-specific perf, PWA / service-worker, and native (React Native) are all `not yet exercised` — this is a web app.

→ see `05-progressive-streaming-perceived-perf.md` for the deep walk on the perceived-perf kernel

## performance-red-flags-audit

Ranked by consequence × likelihood. The discipline is *forcing the rank* — if every item is "high priority," nothing is.

**Top three (HIGH consequence).**

1. **Cost concentration on `synthesize()`** — `lib/agents/diagnostic.ts:87-126`, `lib/agents/recommendation.ts:82-132`. Output-heavy structured JSON, fires whenever the loop fails to emit valid JSON. Unmeasured because no `res.usage` logging. Fix: requires #2 to land first. → see `04-synthesize-as-cost-concentration.md`
2. **`res.usage` logging — partially landed 2026-06-15** — 3 of 5 sites now log (`lib/agents/base.ts:135` runAgentLoop, `base.ts:257` runRecoveryTurn, `lib/agents/intent.ts:36` intent classifier). 2 sites remaining are `lib/agents/diagnostic.ts:87-126` and `lib/agents/recommendation.ts:82-132` synthesize() retries — the exact call sites #1 suspects of dominating. ~2 `console.log` lines closes it. Phase 3 also produced the first real per-investigation cost data: ~$10-15 total across K=10 eval across 4 pillars.
3. **300s route budget pinned at ceiling** — `app/api/agent/route.ts:20`, `app/api/briefing/route.ts:17`. Zero headroom for retry storms. Fix: queue + worker (requires DB) or tighten `maxToolCalls`. → see `01-300s-vercel-budget-as-hard-ceiling.md`

**Middle four (MEDIUM consequence).**

4. **No prompt-prefix caching** — `lib/agents/base.ts:92-101` has no `cache_control` blocks; the 5-10KB system prompts re-tokenize every turn. Fix: insert `cache_control: { type: 'ephemeral' }` (~5 lines per call site).
5. **`investigations` Map grows monotonically** — `lib/state/investigations.ts:11,31`. No `.delete`, no LRU. Bounded only by instance death. Fix: LRU cap (~20 lines).
6. **Schema cache has no TTL** — `lib/mcp/schema.ts:131,170`. Stale until cold restart. Fix: `cachedAt` + TTL check (~10 lines).
7. **No Web Vitals / time-to-first-event metric** — no `useReportWebVitals`, no `performance.mark`. Fix: ~10 lines in `app/layout.tsx`.

**Bottom three (LOW consequence today).**

8. **Per-event setState not batched** — `lib/hooks/useInvestigation.ts:97-150`. Works at today's rates; would matter if event rates jumped. Trigger: streamed text-deltas or fan-out.
9. **NDJSON event size sometimes large** — ~120-200KB per investigation. Bandwidth is cheap. Trigger: constrained mobile network.
10. **Bootstrap chain serialized** — `lib/mcp/schema.ts:178-185`, 4-6 sequential calls (~6-12s cold cost). Not fixable — rate limit forbids parallel. Schema cache mitigates on warm.

**Honest `not yet exercised`:** load testing, profiler integration, batching, formal SLOs. Each has a real "why not" — providers don't support batching; profilers come after monitoring; SLOs need a meter.

## Top 3 ranked findings

1. **`res.usage` logging — partially landed 2026-06-15** — 3 of 5 sites now log (`base.ts:135`, `base.ts:257`, `intent.ts:36`). Close the remaining 2 (`diagnostic.ts:87-126`, `recommendation.ts:82-132` synthesize() retries) to finish unblocking #2.
2. **Cost concentration on `synthesize()`** — `lib/agents/diagnostic.ts:87-126`, `lib/agents/recommendation.ts:82-132` — suspected dominant per-investigation cost (long structured JSON output, fires when loop fails to parse). Cannot be confirmed or fixed until #1 lands. Once measured, lever is tightening `maxToolCalls` (fewer forced syntheses) or reshaping the JSON output (smaller schema).
3. **300s route budget at ceiling, zero headroom** — `app/api/agent/route.ts:20`, `app/api/briefing/route.ts:17` — pinned at Vercel Pro's max. Typical ~100-115s, worst-case retry storm (~280-300s+) crosses the ceiling and the route dies mid-stream. Cheap fix: tighten `maxToolCalls`. Architectural fix: queue + worker (requires DB).

---
Updated: 2026-06-16 — `res.usage` logging partially landed (3 of 5 sites). Cache code moved to `lib/data-source/bloomreach-data-source.ts` post Phase 2 PR A. Phase 3 produced first measured per-investigation cost data (~$10-15 across K=10 × 4 eval pillars). K=10 parallel-run race condition + `EVAL_RUN_TAG` mitigation added as real concurrent-execution anecdote. Asymmetric per-call timeout: Olist has 30s, Bloomreach still has none.

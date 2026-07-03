# audit — the 8-lens walk

Pass 1 of the audit-style shape. Every lens walks the codebase against real evidence — file paths, line numbers, real numbers from runId `2026-07-03T04-08-28-644Z`. Where a lens finds nothing, `not yet exercised` names the gap honestly.

---

## 1. performance-budget

Two budgets are named. Both are enforced. The route ceiling is the outer one; the per-call ceiling is the inner one.

**Route wall-clock budget: 300s.**
`app/api/agent/route.ts:22` and `app/api/briefing/route.ts:19` each set `export const maxDuration = 300` — the Vercel Pro cap. Comment on the agent route names why: "A live investigation (diagnostic → recommendation) runs ~100-115s under the ~1 req/s MCP limit; 60s (Hobby) cannot fit it." Baseline shows p50 total 225s per case, so the cap is defended with ~75s of slack for cases the alpha server misbehaves on.

**Per-MCP-call budget: 30s.**
`lib/mcp/transport.ts:38` — `const TOOL_TIMEOUT_MS = 30_000`. Applied as `AbortSignal.timeout(TOOL_TIMEOUT_MS)` composed with the route's cancellation signal (line 131, 150). A hung Bloomreach connection would otherwise burn the whole 300s route budget on one stuck call; this bounds it. Thrown as `HTTP 0: timeout after 30000ms` so callers can tag the failure.

**Per-investigation cost budget: $2.00 (default).**
`lib/agents/budget.ts` — `BudgetTracker` accumulates token spend across every model turn in one investigation. `lib/agents/aptkit-adapters.ts:64` checks `budget.exceeded()` BEFORE dispatching the next Anthropic call. Default limit `BUDGET_MAX_USD=2.0` in `eval/run.eval.ts:194` and `eval/load.eval.ts:91`. This is an escape valve — the observed per-case cost is ~$0.09, well under the ceiling. See `02-per-investigation-budget-ceiling.md`.

## 2. measurement-baselines-and-profiling

The repo has a baseline, a report generator, and receipts on disk. Cost math uses a Blooming-side pricing helper that AptKit's OpenAI-only `estimateCost` can't cover.

**Baseline runId:** `2026-07-03T04-08-28-644Z`, 10 goldens, stored in `eval/baseline.json`. Per-case files in `eval/receipts/*.json`.

**Instrumentation seams:**
- `lib/agents/aptkit-adapters.ts:97` — `console.log(JSON.stringify({ site, sessionId, usage }))` on every model turn. `res.usage` includes cache_creation and cache_read counts, so the log line is what confirms caching is live.
- `lib/agents/aptkit-adapters.ts:161` — `onCapabilityEvent` forwards every `CapabilityEvent` from AptKit's trace sink, letting `eval/run.eval.ts` feed the trace into `summarizeUsage` + `estimateCost` per invocation.
- `app/api/agent/route.ts:213` and `app/api/briefing/route.ts:200` — per-phase wall-clock timings written to a `phases[]` array and emitted as one summary JSON line per request in the `finally` block. Shape matches across both routes so a single Vercel filter reads both.

**Reporting:**
- `eval/report.eval.ts` reads all receipts for a run and prints per-phase p50/p95/p99/max, per-case token usage + cost, per-tool-call latency stats. Zero-cost — sourced purely from receipts on disk.
- `eval/baseline.eval.ts` builds the aggregate `baseline.json` from a run's receipts.
- `eval/gate.eval.ts` compares a fresh run against the baseline.

**Pricing helper:**
`lib/agents/pricing.ts` — Anthropic pricing filled in because `@aptkit/core`'s `estimateCost` only knows OpenAI. Sonnet family $3 in / $15 out per MTok. Note: does NOT include cache-tier pricing, so cost estimated here is an UPPER BOUND when caching is on.

See `03-observability-report.md` for the deep walk.

## 3. latency-throughput-and-tail-behavior

Baseline p50s land inside budget. p99 has a tail worth calling out.

**Per-phase p50 latency across 10 goldens (baseline runId `2026-07-03T04-08-28-644Z`):**

| phase           | p50   |
| :-------------- | :---- |
| diagnose        | 50s   |
| diagnosis-judge | 38s   |
| recommend       | 51s   |
| rec-judge       | 90s   |
| total           | 225s  |

**The tail:** one rec-judge outlier — case 09 at 675s (5–9× normal). Not systemic; the report notes it as a retry-stacking event on a bad judge response, not a repeat problem. `eval/report.eval.ts:78` computes the percentiles and lists the case in the per-case table so the outlier is visible.

**Load smoke (LOAD_N=2, K=1):** wall clock 208s per investigation (~104s each). Judge-free path — that ~104s is what a diagnose + recommend costs without the two judge calls. Judges add roughly 50% latency.

**Throughput at concurrency:**
`eval/load.eval.ts:210` — semaphore worker pool. `Array.from({ length: LOAD_CONCURRENCY }, (_, i) => worker(i))` and each worker shifts an index off the queue until empty. There's no external work queue; concurrency is the number of parallel investigations against the shared Anthropic key. At K=3, the harness is capacity-limited by Anthropic's per-key rate, not by anything in this repo.

**Anti-pattern the repo avoids:** streaming NDJSON to the browser rather than buffering the whole investigation. `app/api/agent/route.ts:184` builds a `ReadableStream` and `controller.enqueue` fires as each event arrives. TTFB is ~schema_bootstrap time, not total run time.

## 4. cpu-memory-and-allocation

`not yet exercised.`

The hot path is model calls + MCP calls. Local CPU cost is negligible against 50s of network latency per phase. No profiler runs are in-repo, no memory-pressure evidence, no GC tuning. This is honest — the bottleneck isn't here.

When it becomes relevant: if the demo replay ever needs to serve concurrent viewers at higher volume, the in-memory session maps (`lib/state/insights.ts`, `lib/state/investigations.ts`) would become a memory-retention lens finding. Today they carry a few insights per session and get GC'd when the session ends.

## 5. io-network-and-database-bottlenecks

The load-bearing bottleneck sits here. Every finding on this lens is about the Bloomreach loomi connect alpha server.

**Rate limit is server-stated, not client-inferred.**
`lib/mcp/connect.ts:87` comment: "Bloomreach rate-limits per user GLOBALLY and states the window in the error text — observed as both `(1 per 1 second)` and `(1 per 10 second)`." The client-side gate `minIntervalMs = 1100` at line 97 keeps calls spaced above the tighter of the two observed windows. This is compliance, not backpressure. See `05-rate-limit-spacing-and-retry-ladder.md`.

**Retry ladder honors the server's stated window.**
`lib/data-source/bloomreach-data-source.ts:64` — `parseRetryAfterMs` pulls the wait hint out of the error envelope (`"Retry after ~12 seconds"` → 12000ms; `"per 10 second"` → 10000ms). `lib/data-source/bloomreach-data-source.ts:135` — `retryDelayMs = 10_000` (fallback to the observed window when no hint parses), `retryCeilingMs = 20_000` (cap on any single wait), `maxRetries = 3`. Explicit design note: "Latency note: against the 60s route budget (app/api/agent), maxRetries=3 at ~10s each can cost ~30s on a single call, so the cap stays low by default." (The route budget is 300s not 60s now, but the numbers still hold.)

**Per-call timeout.**
`lib/mcp/transport.ts:38` — 30s ceiling on any single MCP round-trip. Fails fast; the retry ladder only retries rate-limit results, not timeouts, so a stuck call errors instead of stacking. Already covered under performance-budget.

**Response cache absorbs repeats.**
`lib/data-source/bloomreach-data-source.ts:145` — 60s TTL, keyed on `${name}:${JSON.stringify(args)}`. Errors not cached (line 179). See `06-response-cache-and-demo-replay.md`.

**Database:** `not yet exercised.` No database in the repo. State is in-memory maps in dev + committed JSON snapshots for demo. Named for what it isn't.

## 6. caching-batching-and-backpressure

Two caches, no batching, no backpressure. Everything here is compliance or memoization.

**Prompt caching — ephemeral cache_control on system prompts.**
`lib/agents/aptkit-adapters.ts:87` — wraps `request.system` in `[{ type: 'text', text: ..., cache_control: { type: 'ephemeral' } }]`. First call: `cache_creation_input_tokens` at ~1.25× normal input cost. Subsequent calls within a 5-min window: `cache_read_input_tokens` at ~10% normal. Live logs confirm: 3168 tokens created on turn 1, 3168 read on turn 2 within the same session. See `01-prompt-caching.md`.

**Response cache — 60s TTL, per-instance memoization.**
Already named under io-network. Also earns a mention here for what it is: a memoization cache on the tool-call surface, not a distributed cache. Per-`BloomreachDataSource` instance (per-request in production). See `06-response-cache-and-demo-replay.md`.

**Batching:** `not yet exercised.` The MCP protocol doesn't currently support batched tool calls, and the agent loop issues one at a time. If it did, the ~1 req/s spacing gate would benefit disproportionately.

**Backpressure:** `not yet exercised.` No queue exists. No work is shed under load. The load harness at `eval/load.eval.ts` runs N investigations at concurrency K, and if K exceeds what Anthropic's per-key rate allows, calls fail rather than queue. This is the load-bearing distinction: what looks like backpressure in this repo is rate-limit compliance, and the difference matters when reasoning about failure modes.

## 7. rendering-client-and-mobile-performance

`not yet exercised.`

The UI is Next.js 16 App Router, React 19, dark-mode-only Tailwind v4. No visible client-perf work in-repo — no bundle-size audit, no per-route lazy loading beyond Next.js defaults, no image-optimization pipeline (there aren't images). The perceptual perf lever the repo pulls is streaming NDJSON so the user sees agent activity within the schema_bootstrap window (~1s in demo, ~3-5s live), not startup optimization.

When it becomes relevant: if the feed page ever renders 100+ insight cards or the reasoning trace ever includes hundreds of tool_call blocks, virtualization becomes worth doing. Today the shapes are ~5-10 cards and ~10-30 trace items.

## 8. performance-red-flags-audit

Ranked risks. Each carries the evidence — a real number or an explicitly named missing measurement.

### R1. The 300s route budget has ~75s of slack at p50; a bad rec-judge outlier can eat it

**Evidence:** Baseline p50 total 225s. rec-judge p99 hit 675s on case 09. If a similar tail landed inside `/api/agent`, the route would time out.
**Mitigation in-place:** `AbortSignal.timeout(30_000)` per MCP call caps a single stuck Bloomreach call, and the retry ladder maxes at 3 attempts × 20s ceiling. The tail is model-side, not MCP-side.
**Fix path:** the budget-ceiling check-before-dispatch (`lib/agents/aptkit-adapters.ts:64`) would trip on runaway token spend, but not on a slow response. A per-agent wall-clock ceiling composed into the `hooks.signal` would name the risk explicitly. Not yet added.

### R2. Cache invalidation is time-based (60s TTL); no explicit invalidation on data change

**Evidence:** `lib/data-source/bloomreach-data-source.ts:186` — cache write with `expiresAt: now + ttl`. No purge API.
**Consequence:** if the underlying Bloomreach data changes within a 60s window (rare but possible during a live analysis session), the agent sees stale data. Acceptable at the alpha stage.
**Fix path:** the `skipCache` option (line 21) is already threaded through — `/debug` uses it. A "force fresh" toggle in the UI would surface it to end users.

### R3. Retry ladder assumes the server's stated window is honest

**Evidence:** `parseRetryAfterMs` at `lib/data-source/bloomreach-data-source.ts:64` extracts the wait hint from the error envelope. If the server states "retry after 5 seconds" but the true window is 30 seconds, the retry fires early and burns an attempt on another 429.
**Consequence:** maxRetries=3 could exhaust in ~15s of stated-but-wrong hints, then error out. The route error path emits a graceful NDJSON `error` event; no data loss.
**Fix path:** track actual 429 rate across retries; if the stated hint keeps missing, extend to backoff. Not yet added — the alpha server has been honest about the window in observed runs.

### R4. Prompt caching depends on prefix stability

**Evidence:** `lib/agents/aptkit-adapters.ts:85` — only `request.system` is marked with `cache_control`. If the system prompt is edited mid-session (it isn't, but the mechanism doesn't prevent it), every turn after the edit is a cache_creation, not a cache_read.
**Consequence:** silent perf regression if a prompt tweak happens in-flight.
**Fix path:** none needed today. The system prompts are `.md` files loaded at process start, not runtime-editable. Named for the mechanism, not for a live threat.

### R5. No CPU / memory profiler runs — the assumption is the hot path is network

**Evidence:** No `.prof` files, no `--inspect` traces, no `--heap-prof` output in-repo.
**Consequence:** if a hot loop shows up in local JSON manipulation (e.g. `JSON.stringify` on a huge tool result), we wouldn't see it until it took real time against the 30s per-call timeout.
**Missing measurement:** a synthetic profiler run against `eval/load.eval.ts` would name any hot loop that wasn't network-bound. Not run.

### R6. Fault injection is offline-only; no chaos test against the live path

**Evidence:** `lib/data-source/fault-injecting.ts` wraps `SyntheticDataSource`. `eval/load.eval.ts:252` — `FAULT_ENABLED` gates the wrap. No integration test exists that wraps `BloomreachDataSource` in production.
**Consequence:** the "agent reasons around faults" property is proven against synthetic data, not live. Fair — production faults are already observed in the wild (429s, revoked tokens) and the same paths handle both.
**Fix path:** none needed today. The synthetic proof is what's build-verifiable; the live proof is what production runs demonstrate.

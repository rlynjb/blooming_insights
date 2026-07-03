# Overview — the performance map of blooming insights

You built an AI analyst that runs on Vercel Pro (300s route ceiling), talks to an alpha MCP server that rate-limits at ~1 req/s and revokes tokens after minutes, and streams a multi-agent ReAct loop to the browser as NDJSON. In the last two weeks you added prompt caching, a per-investigation budget ceiling, an observability report, a load harness, and a fault-injection decorator. This map tells you where the load-bearing bytes go and how the new machinery earns its keep.

## The one distinction that carries the file

**Rate-limit compliance is not backpressure.** The `minIntervalMs = 1100` proactive spacing in `lib/mcp/connect.ts:97` and the 10-second retry ladder in `lib/data-source/bloomreach-data-source.ts:135` exist because Bloomreach's alpha server states its window (`1 per 10 second`) and returns 429 if you cross it. Nothing is queuing calls to protect a slow consumer, no queue depth is being watched, no work is being shed. It's a client-side gate to stay inside a server-stated quota. This distinction is load-bearing enough that the audit calls it out under two lenses (io-network-and-database-bottlenecks and caching-batching-and-backpressure) and pattern `05-rate-limit-spacing-and-retry-ladder.md` opens with it.

## Ranked findings — what to fix first

Ordered by consequence to the ~$1.30 / 10-case eval run + the 300s route budget.

### 1. Prompt caching earns the biggest win — the numbers prove it

The ReAct loop reuses the same system prompt across every turn (3–15 turns per agent). Adding a single `cache_control: { type: 'ephemeral' }` breakpoint at `lib/agents/aptkit-adapters.ts:87` turned the first call into a cache_creation and every subsequent call within 5 min into a cache_read at ~10% the input cost. Live logs prove it: `cache_creation_input_tokens 3168` on the first call matches `cache_read_input_tokens 3168` on the next. **Pattern file:** `01-prompt-caching.md`.

### 2. The 300s route budget is the ceiling that must not tear

`app/api/agent/route.ts:22` and `app/api/briefing/route.ts:19` both set `maxDuration = 300`. The baseline run (10 cases, runId `2026-07-03T04-08-28-644Z`) shows per-phase p50 latency of **diagnose 50s · d-judge 38s · recommend 51s · r-judge 90s · total 225s**. Total under budget, but the r-judge outlier at case 09 hit 675s — five to nine times normal. That's inside a single case in the eval, not a route call, so the route survives, but it names the mechanism: model retries on a bad response can stack. `lib/mcp/transport.ts:38` caps a single MCP call at `TOOL_TIMEOUT_MS = 30_000` so a hung Bloomreach connection can't burn the whole route. **Audit lens:** latency-throughput-and-tail-behavior.

### 3. Budget ceiling is check-before-dispatch, not a soft target

`lib/agents/budget.ts` builds a `BudgetTracker` per investigation. Each model turn calls `budget.exceeded()` BEFORE dispatching to Anthropic (`lib/agents/aptkit-adapters.ts:64`). Throws `BudgetExceededError` if the ceiling has been hit. A runaway ReAct loop can't burn additional cost after the ceiling is crossed. Default is $2.00 (`BUDGET_MAX_USD` env), vs the observed ~$0.09/case — this is an escape valve, not a normal-path constraint. **Pattern file:** `02-per-investigation-budget-ceiling.md`.

### 4. Fault injection proves the agents reason around failures

`lib/data-source/fault-injecting.ts` is a decorator over any `DataSource`. Configurable per-error probabilities for timeout / rate_limit / server_error / malformed_json. The load smoke with `FAULT_TIMEOUT=0.2, FAULT_MALFORMED_JSON=0.2, N=3` injected **9 faults across 3 investigations → 0 investigation failures**. AptKit's ReAct loop presents each fault as a `tool_result` block with `is_error: true`; the model reasons around it and tries a different query. That's the graceful-degradation surface tier-2 promises. **Pattern file:** `04-load-harness-with-fault-injection.md`.

### 5. Response cache — TTL 60s per (tool_name, args)

`lib/data-source/bloomreach-data-source.ts:145` caches every successful tool call for 60 seconds keyed on `${name}:${JSON.stringify(args)}`. Error results are not cached (line 179). The cache is per-`BloomreachDataSource` instance, so per-request in production. It absorbs the "same EQL query fired twice" pattern that shows up when the agent's ReAct loop re-derives a metric. **Pattern file:** `06-response-cache-and-demo-replay.md`.

### 6. The demo replay is the reliability lever, not a perf trick

`?demo=cached` in `app/api/briefing/route.ts:86` serves committed snapshots (`lib/state/demo-*.json`) as NDJSON with a 180ms delay per event. Wall clock 0s for the model. This is presentation-reliability first — the alpha MCP server revokes tokens after minutes — but it also side-steps every performance risk in the live path. Named for what it is.

## Real numbers you should hold

**Baseline (runId `2026-07-03T04-08-28-644Z`, 10 cases, sequential):**

| Phase           | p50   | p95   | p99   |
| :-------------- | :---- | :---- | :---- |
| diagnose        | 50s   |       |       |
| diagnosis-judge | 38s   |       |       |
| recommend       | 51s   |       |       |
| rec-judge       | 90s   |       | 675s  |
| total           | 225s  |       |       |

Per-case cost avg **~$0.09 agent-side**. Total 10-case: **$0.913 agent + ~$0.40 judge ≈ $1.30**.

**Load smoke (LOAD_N=2, K=1, no faults):** wall clock 208s (~104s/investigation). Cost $0.156. Judges add ~50% latency vs the load path (which skips them).

**Load with faults (`FAULT_TIMEOUT=0.2`, `FAULT_MALFORMED_JSON=0.2`, N=3):** 9 injected faults, 0 investigation failures.

**Cache validation live:** `cache_creation_input_tokens 3168` on the first call, matching `cache_read_input_tokens 3168` on the very next call within the same session.

## What earns a pattern file (and what doesn't)

The general rule from `me.md`: a pattern has a name, passes the load-bearing test, passes the recognition test. For performance specifically, the load-bearing test asks — if I stripped this out, what measurable capability would the system lose? Real answers name a number.

Six patterns earn files here. Everything else is a lens finding in `audit.md`. The lenses that find nothing (rendering-client-and-mobile-performance, cpu-memory-and-allocation) emit `not yet exercised` with an honest note.

# study-performance-engineering

Per-repo performance audit for blooming insights. Audit-style two-pass output: one `audit.md` walking the 8-lens inventory, plus five discovered-pattern files for the patterns the codebase actually exercises.

## Reading order

```
  00-overview.md                              ← orientation: the map, the ranked findings,
                                                the partition with neighbors
  audit.md                                    ← Pass 1: the 8-lens audit (the survey)

  01-300s-vercel-budget-as-hard-ceiling.md    ← Pass 2: pattern files (the deep walks)
  02-ttl-cache-with-no-cache-on-error.md
  03-spacing-gate-as-rate-limit-compliance.md
  04-synthesize-as-cost-concentration.md
  05-progressive-streaming-perceived-perf.md
```

Start with `00-overview.md` for the one-page orientation, then `audit.md` for the 8-lens survey. The numbered pattern files (`01-` through `05-`) are deep walks on the patterns that actually pop in this codebase — read them in order (most foundational first) or jump to the one that matches the question you're answering.

## The five pattern files (why each earned a spot)

- **`01-300s-vercel-budget-as-hard-ceiling`** — `maxDuration = 300` at `app/api/agent/route.ts:20` and `app/api/briefing/route.ts:17` is pinned at Vercel Pro's ceiling. Every other budget in the system fits underneath. Load-bearing: removing it drops the route to 60s and the agent dies mid-recommend.
- **`02-ttl-cache-with-no-cache-on-error`** — the `McpClient.cache` (`lib/mcp/client.ts:80,102-110,137-145`) returns 0ms on hit by skipping both spacing gate AND network. The error-bypass guard at `:137-145` is the load-bearing correctness move — without it, a rate-limit error poisons the cache for 60s.
- **`03-spacing-gate-as-rate-limit-compliance`** — the 5 lines at `lib/mcp/client.ts:148-152` are the most misread piece of perf code in the repo. The pattern IS the distinction: it's NOT backpressure. Naming what it actually does is load-bearing for what breaks if a fan-out feature ever ships.
- **`04-synthesize-as-cost-concentration`** — the suspected dominant per-investigation cost line (`lib/agents/diagnostic.ts:87-126`, `lib/agents/recommendation.ts:82-132`) — and the load-bearing fact is that it's *suspected*, not measured. The unmeasured state IS the pattern.
- **`05-progressive-streaming-perceived-perf`** — the four UX moves (NDJSON streaming, skeletons, ProcessStepper, StatusLog) that convert 100s of actual latency into 1-2s of perceived time-to-feedback. The load-bearing detail is `Cache-Control: no-cache, no-transform` — without it, intermediary buffering silently collapses the whole strategy.

## What's NOT a pattern file (and why)

The audit lens findings live in `audit.md`'s `##` sections — not as separate files. Examples kept in the audit:

- The four hard budgets (the catalog of what's codified) — lives in `audit.md#performance-budget`. The deep walk on the 300s budget (the most consequential one) is promoted to `01-`; the other three (`maxToolCalls`, `MAX_TOOL_RESULT_CHARS`, `minIntervalMs`) are named but not promoted because the 300s budget is the one that's load-bearing on its own.
- The five meters (one real, four absent) — lives in `audit.md#measurement-baselines-and-profiling`. The deep walk on the consequence (cost concentration unmeasured) is promoted to `04-`; the measurement gap itself lives in the audit.
- The four memory shapes — lives in `audit.md#cpu-memory-and-allocation`. No memory pattern is load-bearing enough to promote (the codebase is I/O-bound by structure).
- The four I/O types — lives in `audit.md#io-network-and-database-bottlenecks`. The dominant I/O is Bloomreach, but the *pattern* worth promoting is the cache that removes the call (promoted as `02-`), not the call itself.

The discipline: 3-8 pattern files for a typical repo (per `me.md`); calibrated to 5 here because the codebase is medium-sized and 5 is the count of patterns that pass has-a-name + load-bearing + recognition.

## Cross-links to sibling guides

- `.aipe/study-system-design/audit.md#scale-bottlenecks-and-evolution` — Move C (queue + worker) at scale, the second ceiling
- `.aipe/study-system-design/audit.md#storage-choice-and-durability-boundaries` — why there's no database
- `.aipe/study-agent-architecture/05-production-serving/01-cross-turn-caching.md` — the three cache scopes
- `.aipe/study-agent-architecture/05-production-serving/02-fan-out-backpressure.md` — the topology that would force backpressure to exist
- `.aipe/study-ai-engineering/06-production-serving/01-llm-caching.md` — prompt-prefix caching (R4)
- `.aipe/study-ai-engineering/06-production-serving/02-llm-cost-optimization.md` — the cost-theory layer

## On UPDATE

Per `me.md`'s AUDIT-STYLE GENERATORS section: regenerate `audit.md` against current evidence. Add new pattern files only when the codebase grows a new mechanism. Update existing pattern files when implementations change. Remove pattern files only when the mechanism is genuinely gone (not just refactored).

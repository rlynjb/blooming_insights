# Study — Debugging & Observability

Audit-style guide for blooming insights' debugging and observability shape: what evidence exists at every layer (three online observability surfaces today), what doesn't, and the patterns that earned their own deep walks.

## Reading order

1. **`00-overview.md`** — the orientation, ranked verdict, and reading paths by need.
2. **`audit.md`** — Pass 1: the 8-lens audit (observability-map, reproduction-and-evidence, structured-logs-and-correlation, metrics-slis-slos-and-alerts, traces-and-request-lifecycles, state-snapshots-and-debugging-boundaries, incident-analysis-and-prevention, debugging-observability-red-flags-audit). One `##` per lens, ending with the Top 3 ranked findings.
3. **Pass 2 — the discovered pattern files (most foundational first):**
   - `01-ndjson-agentevent-discriminated-union.md` — the 8-line typed event union every online layer speaks. `lib/mcp/events.ts:4–17`. AptKit traces now ALSO flow through this surface via `BloomingTraceSinkAdapter` (`lib/agents/aptkit-adapters.ts:100`) — same NDJSON contract, additional producer.
   - `02-replay-from-snapshot-with-paced-emission.md` — the cache-first short-circuit that re-emits captured events at 180ms ticks. `app/api/agent/route.ts:127–141`.
   - `03-three-rung-mem-file-seed-store.md` — the mem → dev file → committed seed cache that survives different scopes. `lib/state/investigations.ts:7–41`.
   - `04-dual-write-send-to-stream-and-store.md` — the two-line closure that writes every event to both the wire and the snapshot buffer. `app/api/agent/route.ts:172–175`.
   - `05-auth-secret-flake-postmortem.md` — the only documented incident in the repo, as a reusable post-mortem template. Commit `e83a8e0`; `test/mcp/auth.test.ts:117–122`.
   - `06-eval-result-paper-trail.md` — **RETIRED 2026-06-18.** Authored when the repo had an offline Olist eval pipeline; that pipeline was removed in PR #8 / commit 62c24d7. The pattern is real and still worth reading (an offline result-dir as a 4th observability surface, `EVAL_RUN_TAG` as the bisect primitive, LLM-as-judge as a debug signal, the measure → fix → re-measure flywheel as a methodology). The code anchors no longer exist.

## Pick by need

- **Understand the trace as substrate** → `01-` then `04-`.
- **A real bug landed in your inbox** → `audit.md` (reproduction-and-evidence), then `02-`, then `05-` for the post-mortem template.
- **Doing a triage / hand-off** → `audit.md` Top 3 ranked findings.
- **Why the metrics section is so short** → `audit.md` (metrics-slis-slos-and-alerts) — read it precisely *because* it names what isn't here.
- **Curious about offline eval as a debugging substrate** → `06-` (RETIRED — pattern still teaches, no current code anchors).

## Cross-links (neighboring guides)

- `.aipe/study-ai-engineering/05-evals-and-observability/04-llm-observability.md` — the same `AgentEvent` stream from the LLM-telemetry angle. Cross-link, don't duplicate.
- `.aipe/study-testing/` — owns the test-design lessons that surround the flake-fix incident.
- `.aipe/study-performance-engineering/` — owns aggregated latency and bottleneck analysis. This guide names `durationMs` as the primitive; that one owns what to do with it.
- `.aipe/study-system-design/05-streaming-ndjson.md` — the NDJSON wire as a system-design pattern.
- `.aipe/study-system-design/04-caching-and-rate-limiting.md` — the broader caching pattern around the 3-rung store.

## What's `not yet exercised`

Named honestly in `audit.md` (metrics-slis-slos-and-alerts, incident-analysis-and-prevention, debugging-observability-red-flags-audit lenses):

- metrics aggregation (no histogram, no time-series store)
- on-call rotation / PagerDuty / SLAs
- SLO definitions / error budgets / alerting thresholds
- structured logger (`lib/log.ts`)
- backend trace sink (OpenTelemetry / Langfuse / Datadog export)
- error monitoring (Sentry, Bugsnag)
- runbooks
- offline eval surface (RESOLVED-BY-DELETION — Olist pipeline removed PR #8 / 62c24d7)

---
Updated: 2026-06-19 — Olist pipeline removed in PR #8 / 62c24d7; reverted reading order to mark `06-` as RETIRED; removed bug-class split (no live model-level surface); dropped eval-related `not yet exercised` rows; added AptKit-into-NDJSON note on `01-`.

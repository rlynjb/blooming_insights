# Study — Debugging & Observability (blooming insights)

> The trace IS the product. blooming insights renders an NDJSON event stream of the agent's reasoning + tool calls as the user-facing surface, snapshots the same events for replay, and times every MCP call with `durationMs`. That is unusually strong substrate for an early-stage codebase. What's missing is everything backend-grade: no structured logger, no metrics pipeline, no Sentry/OTel/Langfuse, no on-call rotation, no SLOs. Honest about both halves.

---

## The repo's shape, observability axis first

```
  blooming insights through the observability lens

  ┌─ UI (renders the trace live) ────────────────────┐
  │  ReasoningTrace · StatusLog · ProcessStepper      │
  └─────────────────────────▲────────────────────────┘
                            │  NDJSON lines
  ┌─ Route handler (frames events) ──────────────────┐
  │  /api/agent   · send(e) → controller.enqueue      │
  │  /api/briefing · same shape + workspace/coverage  │
  └─────────────────────────▲────────────────────────┘
                            │
  ┌─ Agent loop (emits events) ──────────────────────┐
  │  hooks: onText / onToolCall / onToolResult        │
  │  → reasoning_step / tool_call_start / _end        │
  │  durationMs measured around the MCP call          │
  └─────────────────────────▲────────────────────────┘
                            │
  ┌─ Provider + tools ──────┴────────────────────────┐
  │  Anthropic · Bloomreach MCP                       │
  │  console.error in 2 route catch blocks            │
  └──────────────────────────────────────────────────┘

  state ownership          │   the trace IS the product
  failure containment      │   try/catch in the stream's start()
  durability               │   saveInvestigation → mem→file→seed
  metrics                  │   durationMs only, not aggregated
  alerts / SLOs            │   not yet exercised
```

This guide reads the codebase through that single axis: **at every layer, what evidence exists, and what doesn't?** Each concept file walks one slice.

## The verdict, ranked

The ranking spotlights what's load-bearing in this repo, not a generic checklist.

1. **The NDJSON event union is the load-bearing primitive.** `lib/mcp/events.ts:4–12` defines `AgentEvent` as a discriminated union; `encodeEvent` is one JSON.stringify + '\n'. That eight-line file is the contract every observability surface in the app speaks. If you rebuild this codebase from scratch, this file is what you write first.

2. **`saveInvestigation(id, events[])` makes the trace replayable.** `lib/state/investigations.ts:30–41` snapshots the captured `AgentEvent[]` to mem→file. `getCachedInvestigation` reads back through mem→dev-file→committed demo seed. The investigation route replays the cached stream with an artificial 180ms tick so the UI animates identically to a live run (`app/api/agent/route.ts:127–141`). State snapshots that double as time-travel debugging — strong for an early-stage repo.

3. **`durationMs` is the only metric primitive — and it's per-call, never aggregated.** `lib/mcp/client.ts:112,134` measures wall-clock around each MCP `liveCall`; `tool_call_end` carries it forward through the trace. It's enough to show "this tool took 340ms" in the UI. It is NOT enough to answer "what's p95 over the last hour" — there's no histogram, no time-series store, no rollup. Cited honestly in `04-metrics-slis-slos-and-alerts.md` as `not yet exercised` past the per-call number.

4. **Logs are unstructured and rare.** Four `console.error` calls in the entire repo — all in the two route handler catch blocks (`app/api/agent/route.ts:160,256`; `app/api/briefing/route.ts:166,248`). No logger, no levels, no correlation ID, no redaction. The correlation primitive that *does* exist is the trace itself — every event in a stream belongs to one investigation, no IDs needed.

5. **The flake-fix in `e83a8e0` is the canonical incident-post-mortem story.** `process.env.AUTH_SECRET` was mutated directly inside one test file; vitest's parallel workers leaked the var across files, so the crypto round-trip test passed in isolation and flaked ~1-in-N in a full run. The fix is `vi.stubEnv` + `vi.unstubAllEnvs` in `beforeEach`/`afterEach` (`test/mcp/auth.test.ts:117–122`). One-file diff, named root cause, regression-guarded by the test discipline itself. The repo's only "incident" with a documented post-mortem — used as the worked example in `07-incident-analysis-and-prevention.md`.

6. **Two backend-grade gaps are honest and named.** No incident tooling (no Sentry, no on-call rotation, no runbooks, no SLO definitions). No backend trace sink (no OpenTelemetry/Langfuse export, even though `@opentelemetry/api` is transitively in `node_modules` via Next.js). `08-debugging-observability-red-flags-audit.md` ranks them by consequence.

## Per-section verdict

| section                                          | verdict       | what carries it / what's missing                                                                                                                              |
|--------------------------------------------------|---------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 01 observability-map                             | strong        | every layer has at least one evidence channel; the map names them all and the gaps.                                                                            |
| 02 reproduction-and-evidence                     | strong        | the cache snapshot IS the reproduction primitive — replay an investigation deterministically with no MCP/Anthropic creds.                                      |
| 03 structured-logs-and-correlation               | partial       | trace = correlation. logs = 4× `console.error`, no levels, no logger, no redaction. honestly named.                                                            |
| 04 metrics-slis-slos-and-alerts                  | weak — honest | `durationMs` per call exists; nothing aggregates it; SLOs/alerts `not yet exercised`. teaches the gap.                                                          |
| 05 traces-and-request-lifecycles                 | strong        | NDJSON `AgentEvent` IS a trace; bracketed `tool_call_start`/`_end` are spans; `durationMs` is span latency. cross-link to `study-ai-engineering/05-…04-llm-observability.md`, don't duplicate. |
| 06 state-snapshots-and-debugging-boundaries      | strong        | `saveInvestigation` + the mem→file→seed chain + the demo replay flow.                                                                                          |
| 07 incident-analysis-and-prevention              | one example   | the `e83a8e0` flake-fix walked end-to-end; no Sentry/runbook/rotation past that.                                                                               |
| 08 debugging-observability-red-flags-audit       | the rank      | ranked blind spots with evidence — read this if you only have ten minutes.                                                                                     |

## Reading order

Read the overview, then `01-observability-map.md` for the bird's-eye. Then pick by need:

- **understand the trace as substrate** → `05-traces-and-request-lifecycles.md`, then `06-state-snapshots-and-debugging-boundaries.md`.
- **a real bug landed in your inbox** → `02-reproduction-and-evidence.md`, then `07-incident-analysis-and-prevention.md`.
- **doing a triage / hand-off** → `08-debugging-observability-red-flags-audit.md` first.
- **why the metrics section is so short** → `04-metrics-slis-slos-and-alerts.md` — read it precisely *because* it names what isn't here.

## Cross-links (don't duplicate)

- `.aipe/study-ai-engineering/05-evals-and-observability/04-llm-observability.md` — covers the same `AgentEvent` stream from the LLM-observability angle (trace = product surface, span = bracketed tool call, replay = cache snapshot). This guide cross-links into that file rather than re-teaching it; the angle here is generic debugging/observability (what evidence exists at every boundary), not specifically LLM telemetry.
- `.aipe/study-testing/` — owns the testing discipline that surrounds the flake-fix (parallel-worker isolation, env stubbing as a pattern). This guide uses the flake-fix as the *incident* worked example; the testing guide owns the *test-design* lesson.
- `.aipe/study-performance-engineering/` — owns aggregated latency and bottleneck analysis. This guide names `durationMs` as the *primitive*; the performance guide owns what to *do* with it.

## What's `not yet exercised` (explicit)

- **metrics aggregation** — no histogram, no rollup, no time-series store. `durationMs` is per-call only.
- **on-call rotation** — solo repo, no PagerDuty/Opsgenie, no rotation schedule, no escalation policy.
- **SLO/SLA definitions** — no error-budget math, no defined service objective, no alerting thresholds.
- **structured logger** — no pino/winston/bunyan/logger.ts module; `console.error` × 4 is the entire backend log surface.
- **backend trace sink** — no OpenTelemetry/Langfuse/Datadog export; the trace lives in the UI + cache snapshot only.
- **error monitoring** — no Sentry, no Bugsnag, no client-side error reporting.
- **runbooks** — no `docs/runbooks/` directory, no incident response playbook past "read the trace".

Each is called out in the relevant section, not buried.

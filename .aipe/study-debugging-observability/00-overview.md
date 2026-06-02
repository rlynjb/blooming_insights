# Study — Debugging & Observability (blooming insights)

> The trace IS the product. blooming insights renders a typed NDJSON `AgentEvent` stream as the user-facing surface, snapshots the same events for replay, and times every MCP call with `durationMs`. That's an unusually strong substrate for an early-stage codebase. What's missing is everything backend-grade: no structured logger, no metrics pipeline, no Sentry/OTel/Langfuse, no on-call rotation, no SLOs. Honest about both halves.

---

## How this guide is structured

This is an **audit-style** guide, in two passes.

**Pass 1 — `audit.md`.** One file walks the 8-lens inventory (observability-map, reproduction-and-evidence, structured-logs-and-correlation, metrics-slis-slos-and-alerts, traces-and-request-lifecycles, state-snapshots-and-debugging-boundaries, incident-analysis-and-prevention, debugging-observability-red-flags-audit). Each lens gets one `##` section: what the codebase actually does, with `file:line` grounding, or `not yet exercised` honestly. Lenses with significant findings cross-link into pattern files.

**Pass 2 — the discovered-pattern files (`01-` through `05-`).** Five patterns earned their own files because they pass the three tests in `me.md`: they have a name, they're load-bearing (something specific breaks if you remove them), and a senior engineer skimming the file list recognizes each as a real architectural pattern.

The file list itself is a learning artifact — read it once and you know what's interesting about how this repo handles observability.

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

This guide reads the codebase through that single axis: **at every layer, what evidence exists, and what doesn't?** `audit.md` walks all 8 lenses; the pattern files take the load-bearing patterns deep.

---

## The verdict, ranked

The ranking spotlights what's load-bearing in this repo, not a generic checklist.

1. **The NDJSON event union is the load-bearing primitive.** `lib/mcp/events.ts:4–12` defines `AgentEvent` as a discriminated union; `encodeEvent` is one JSON.stringify + '\n'. That eight-line file is the contract every observability surface in the app speaks. If you rebuild this codebase from scratch, this file is what you write first. → `01-ndjson-agentevent-discriminated-union.md`

2. **The cache-first replay path makes the trace re-creatable.** `app/api/agent/route.ts:127–141` short-circuits the live run when a cached `AgentEvent[]` exists, re-emitting it at 180ms ticks so the UI can't tell live from replay. No creds required for seeded runs. → `02-replay-from-snapshot-with-paced-emission.md`

3. **`saveInvestigation(id, events[])` lifts the trace into a 3-rung store.** `lib/state/investigations.ts:7–41` writes the captured `AgentEvent[]` to mem (per-process), the dev file (`.investigation-cache.json`, dev only), and the committed seed (`lib/state/demo-investigations.json`, crosses deploys). Each rung serves a different scope. → `03-three-rung-mem-file-seed-store.md`

4. **The dual-write `send(e)` closure is what makes the same trace serve live AND replay.** `app/api/agent/route.ts:172–175` pushes to `collected[]` and enqueues NDJSON bytes on every call — one closure, two destinations. Drop the push and replay dies; drop the enqueue and the live UI dies. → `04-dual-write-send-to-stream-and-store.md`

5. **The `e83a8e0` flake-fix is the canonical incident post-mortem.** `process.env.AUTH_SECRET` was mutated directly inside one test file; vitest's parallel workers leaked the var across files. Fix is `vi.stubEnv` + `vi.unstubAllEnvs` in `beforeEach`/`afterEach`. The post-mortem shape generalises to any future incident. → `05-auth-secret-flake-postmortem.md`

6. **`durationMs` is the only metric primitive — and it's per-call, never aggregated.** `lib/mcp/client.ts:112,134` measures wall-clock around each MCP `liveCall`; `tool_call_end` carries it forward through the trace. It's enough to show "this tool took 340ms" in the UI. It is NOT enough to answer "what's p95 over the last hour" — there's no histogram, no time-series store, no rollup. Cited honestly in `audit.md` (metrics-slis-slos-and-alerts) as `not yet exercised` past the per-call number.

7. **Logs are unstructured and rare.** Four `console.error` calls in the entire repo — all in the two route handler catch blocks. No logger, no levels, no correlation ID, no redaction. The correlation primitive that *does* exist is the trace itself — every event in a stream belongs to one investigation, no IDs needed. Top-3 finding in `audit.md`.

8. **Two backend-grade gaps are honest and named.** No incident tooling (no Sentry, no on-call rotation, no runbooks, no SLO definitions). No backend trace sink (no OpenTelemetry/Langfuse export, even though `@opentelemetry/api` is transitively in `node_modules` via Next.js). `audit.md` (debugging-observability-red-flags-audit lens) ranks them by consequence.

---

## Reading order

1. **`audit.md`** — the one-pass survey across all 8 lenses. Verdict-first; ends with the Top 3 ranked findings.
2. **`01-ndjson-agentevent-discriminated-union.md`** — the foundational pattern. Every other file depends on this 8-line union.
3. **`02-replay-from-snapshot-with-paced-emission.md`** — the cache-first short-circuit that makes the trace a real reproduction primitive.
4. **`03-three-rung-mem-file-seed-store.md`** — the persistence layer; each rung serves a different scope.
5. **`04-dual-write-send-to-stream-and-store.md`** — the two-line closure that makes the same trace serve both live and replay.
6. **`05-auth-secret-flake-postmortem.md`** — the one documented incident, as a reusable template for future ones.

**Then pick by need:**

- **understand the trace as substrate** → start at `01-` then `04-`.
- **a real bug landed in your inbox** → `audit.md` (reproduction-and-evidence), then `02-`, then `05-` for the post-mortem template.
- **doing a triage / hand-off** → `audit.md` Top 3 ranked findings.
- **why the metrics section is so short** → `audit.md` (metrics-slis-slos-and-alerts) — read it precisely *because* it names what isn't here.

## Cross-links (don't duplicate)

- `.aipe/study-ai-engineering/05-evals-and-observability/04-llm-observability.md` — covers the same `AgentEvent` stream from the LLM-observability angle (trace = product surface, span = bracketed tool call, replay = cache snapshot). This guide cross-links into that file rather than re-teaching it; the angle here is generic debugging/observability (what evidence exists at every boundary), not specifically LLM telemetry.
- `.aipe/study-testing/` — owns the testing discipline that surrounds the flake-fix (parallel-worker isolation, env stubbing as a pattern). This guide uses the flake-fix as the *incident* worked example; the testing guide owns the *test-design* lesson.
- `.aipe/study-performance-engineering/` — owns aggregated latency and bottleneck analysis. This guide names `durationMs` as the *primitive*; the performance guide owns what to *do* with it.
- `.aipe/study-system-design/05-streaming-ndjson.md` — the NDJSON wire as a system-design pattern.
- `.aipe/study-system-design/04-caching-and-rate-limiting.md` — the broader caching pattern around the 3-rung store.

## What's `not yet exercised` (explicit)

- **metrics aggregation** — no histogram, no rollup, no time-series store. `durationMs` is per-call only.
- **on-call rotation** — solo repo, no PagerDuty/Opsgenie, no rotation schedule, no escalation policy.
- **SLO/SLA definitions** — no error-budget math, no defined service objective, no alerting thresholds.
- **structured logger** — no pino/winston/bunyan/logger.ts module; `console.error` × 4 is the entire backend log surface.
- **backend trace sink** — no OpenTelemetry/Langfuse/Datadog export; the trace lives in the UI + cache snapshot only.
- **error monitoring** — no Sentry, no Bugsnag, no client-side error reporting.
- **runbooks** — no `docs/runbooks/` directory, no incident response playbook past "read the trace".

Each is called out in the relevant `audit.md` lens, not buried.

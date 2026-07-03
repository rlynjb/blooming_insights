# Audit — the 8 lenses, applied

One `##` section per lens. Each names what the codebase actually does
(with `file:line`) or emits `not yet exercised` honestly. Cross-links
into the Pass-2 pattern files for the deep walks.

## 1. observability-map — the evidence map

The system has three concentric evidence rings. Read them out from
the browser and each ring exposes strictly more than the last.

```
  The three rings of evidence

  ┌─ Ring 1 · live browser view ─────────────────────────────┐
  │  ReasoningTrace + ToolCallBlock rendering the NDJSON      │
  │  stream from /api/briefing or /api/agent                  │
  │  gone the moment the tab closes                          │
  └──────────────────────────────────────────────────────────┘
                        ▲
                        │ same events, one-shot
                        │
  ┌─ Ring 2 · in-process state ──────────────────────────────┐
  │  saveInvestigation() → in-memory Map + dev-only JSON      │
  │  file (.investigation-cache.json)                        │
  │  route.ts:305 (COMBINED runs only)                       │
  └──────────────────────────────────────────────────────────┘
                        ▲
                        │ synthetic-substrate only
                        │
  ┌─ Ring 3 · durable receipts on disk ──────────────────────┐
  │  eval/receipts/<case>-<runId>.json — the debuggable       │
  │  ledger; anomaly + diagnosis + judgment + tool trace     │
  │  + usage + cost + budget                                 │
  └──────────────────────────────────────────────────────────┘
```

**Ring 1 — the wire.** `AgentEvent` (`lib/mcp/events.ts:5-14`) is the
8-variant discriminated union: `reasoning_step` / `tool_call_start` /
`tool_call_end` / `insight` / `diagnosis` / `recommendation` / `done` /
`error`. Producers use `encodeEvent(e)` (`events.ts:17`), consumers use
`readNdjson` (`lib/streaming/ndjson.ts` — the 64-LOC kernel). This
carries everything the UI has to show. → deep walk in
`01-ndjson-live-trace.md`.

**Ring 2 — server-side one-shot memory.** `lib/state/investigations.ts`
holds combined `diagnose+recommend` runs in a per-session in-memory
map, backed by a gitignored JSON file only in dev
(`investigations.ts:7`). The split-step runs are held only on the
client via `sessionStorage`, so they die with the tab.

**Ring 3 — the receipts.** `eval/receipts/<case>-<runId>.json` is the
only surface that survives across sessions with *provenance*:
anomaly (input), diagnosis (agent output), diagnosisJudgment (judge
output), tool-call trace, per-agent usage row, per-agent cost, and a
budget snapshot. Sample receipt: 424 lines /
`09-engagement-drop-email-campaign-2026-07-03T04-08-28-644Z.json`. →
deep walk in `03-capability-trace-receipts.md`.

## 2. reproduction-and-evidence

**Repro is genuinely cheap here — three modes.**

  → **`?demo=cached`** — plays back the committed snapshot
    (`lib/state/demo-insights.json`) as NDJSON, delay-throttled to
    140ms per event (`briefing/route.ts:25`, `agent/route.ts:104`). No
    auth, no API cost, deterministic. This is the reliable presentation
    path AND the reliable "make the UI render this exact scenario" tool.

  → **`SyntheticDataSource`** — an in-process fake data source that
    both `eval/run.eval.ts` and `eval/load.eval.ts` bind to. Any bug
    triggered by the golden cases is reproducible without touching
    Bloomreach, and the schema is fixed
    (`syntheticWorkspaceSchema`).

  → **`FaultInjectingDataSource`** — a decorator with configurable
    per-call rates for `timeout / rate_limit / server_error /
    malformed_json` (`lib/data-source/fault-injecting.ts:31-39`).
    Deterministic when you set `FAULT_SEED` (`fault-injecting.ts:41`),
    fully non-deterministic otherwise. This is how you exercise the
    "Bloomreach 429'd mid-scan" path locally. → deep walk in
    `05-fault-injecting-load-harness.md`.

Hypotheses get tested by writing a golden case (`eval/goldens/`) with
an expected-shape rubric, running the eval, and reading the judgment
verdict + rationale off the receipt. This is closer to a science
notebook than an ad-hoc `console.log`.

## 3. structured-logs-and-correlation

Server-side logs are `console.log(JSON.stringify(...))` in
five load-bearing sites — all shipping structured records to Vercel's
log pipeline via stdout scraping.

| Site | Shape | Purpose |
|---|---|---|
| `app/api/briefing/route.ts:317-323` | `{ route, sessionId, mode, totalMs, phases[], aborted }` | one summary per request |
| `app/api/agent/route.ts:331-337` | same shape | one summary per request (agent) |
| `lib/agents/aptkit-adapters.ts:97-101` | `{ site, sessionId, usage }` | per model turn |
| `lib/agents/base-legacy.ts:135`, `256` | `{ site, sessionId, usage }`, `{ site, ... }` | legacy — same shape |
| `lib/agents/intent-legacy.ts:36` | `{ site, sessionId, usage }` | legacy classifier |

The shape is **deliberately shared** across the two streaming routes
so a single Vercel filter (`route = "/api/briefing"` OR `phases.phase
= "monitoring_scan"`) reads across both — the comment at
`briefing/route.ts:316-319` names this explicitly. → deep walk in
`02-per-phase-request-summary.md`.

**Correlation ID.** There is one: `sessionId` — the value of the
`bi_session` cookie (`lib/mcp/session.ts:16-24`). It's stamped on
every log line at every site listed above. There's **no request ID
separate from the session**, so two concurrent requests from the same
browser tab share a correlation key — this is acceptable at the
current scale (one user, alpha demo) but starts to hurt once you have
multiple parallel requests per session.

**Redaction.** `redactSecrets` (`lib/mcp/transport.ts:66-76`) strips
Bearer headers and OAuth token JSON fields before they hit a log.
Applied at every server-side `console.error` call site (via
`formatError(e)` → `redactSecrets(...)`). The redaction is only for
OAuth-shaped secrets; there is no PII redaction for Bloomreach
customer data flowing through EQL results.

## 4. metrics-slis-slos-and-alerts

**not yet exercised** as a live metrics pipeline. No Prometheus, no
Datadog, no OpenTelemetry metrics.

What DOES exist is metrics computed on demand from the receipts:

- `eval/report.eval.ts:78-96` — p50/p95/p99/max/mean per phase
  (investigate / diag-judge / recommend / rec-judge / total).
- `eval/report.eval.ts:130-141` — per-tool-call latency distribution.
- `eval/baseline.eval.ts` — per-dimension pass rates + verdict
  distributions across all cases in a run.

These are **eval-time SLIs** — computed after a run finishes, printed
to stderr. There is no threshold, no page, no alert. The closest thing
to an SLO is the regression gate in `eval/gate.eval.ts` — see lens 7.

**When this starts to matter.** As soon as blooming insights sees
sustained production traffic, "p95 total request latency" becomes a
number someone wants to look at *between* runs, not just when
Rein re-runs `npm run eval:report`. That's when you'd wire OTel
metrics or ship the per-phase log lines into a real time-series DB.

## 5. traces-and-request-lifecycles

**Per-request tracing exists as the phase log,** at approximately
"5 spans per request" granularity:

Briefing route phases (`briefing/route.ts:221-281`):
- `schema_bootstrap` → `coverage_gate` → `list_tools` → `monitoring_scan`

Agent route phases (`agent/route.ts:236-295`, conditional on flow):
- `schema_bootstrap` → `list_tools` → then EITHER `intent_classify` +
  `query_answer` (free-form query) OR `diagnostic_investigate` +
  `recommendation_propose` (investigation)

Each phase records via `recordPhase(name, startedTs)` (`route.ts:217`)
into a per-request array, and the array ships as `phases[]` in the
final summary log. The comment at `briefing/route.ts:200-202` names
the design: **the finally block always fires, so we get the phase log
even when a phase throws**, and can see how much of the 300s budget
was burned before the failure.

**Deeper drill-down happens inside the aptkit trace sink.**
`BloomingTraceSinkAdapter.emit()` (`lib/agents/aptkit-adapters.ts:143-
174`) receives every `CapabilityEvent` from aptkit — including
`model_usage` events with per-turn cache_creation / cache_read token
counts. The `onCapabilityEvent` hook forwards this to any caller that
wants it (the eval runner does). → deep walk in
`03-capability-trace-receipts.md`.

**What's NOT here:** no OpenTelemetry span IDs, no parent/child span
relationships, no distributed context propagation. The whole stack is
one Node process; the phase log is the trace.

## 6. state-snapshots-and-debugging-boundaries

Three snapshot surfaces the debugger reaches for.

**Snapshot A · in-flight NDJSON.** Pipe the stream to a file:

```
curl -s 'http://localhost:3000/api/briefing?mode=live-synthetic' > trace.ndjson
```

Each line is a self-describing `AgentEvent`. Everything the UI would
have shown is reproducible from the file via `readNdjson`.

**Snapshot B · the receipt.** Written by
`eval/run.eval.ts:305-321`. Contains not just the outputs but the
**full aptkit trace** the outputs were derived from (`diagnosisTrace`
+ `recommendationTrace` are held in memory during the run and
summarized into the `usage` row on write). If a diagnosis is wrong,
you have every model turn's token count and every tool call's args +
result truncated to 4000 chars (`run.eval.ts:96` — `trunc()`) — enough
to diagnose "the agent hallucinated a fact" vs "the tool returned bad
data."

**Snapshot C · captured HTTP error body.** `makeCapturingFetch`
(`lib/mcp/transport.ts:103-118`) records the body of any non-2xx
Bloomreach response into an `HttpErrorHolder`, so when the MCP SDK
throws its generic `Unauthorized`, the transport can rethrow with the
**real server body** attached (`transport.ts:139-143`). Without this,
alpha-server errors would surface as generic "Unauthorized" with no
clue what happened.

## 7. incident-analysis-and-prevention

**The prevention loop the repo actually runs:**

```
  golden case exercises a hypothesis
        │
        ▼
  eval/run.eval.ts writes a per-case receipt
        │
        ▼
  eval/baseline.eval.ts summarizes N receipts into
    per-dimension pass rates + verdict distribution
        │
        ▼
  committed to eval/baseline.json
        │
        ▼
  next run: eval/gate.eval.ts compares candidate vs
    baseline; blocks if any dimension regresses > 10pp
```

The gate is at `eval/gate.eval.ts:47-93`. Threshold default
`GATE_MAX_REGRESSION=0.10` (10 percentage points), configurable per
run. → deep walk in `04-baseline-and-regression-gate.md`.

**Incidents observed in the current baseline (2026-07-03T04-08-28-644Z):**

- `rec-judge` p99 outlier at case 09 (`819598ms total`,
  `675185ms recommendationJudge` — see the sample receipt). The judge
  retried multiple times on that case. The report surfaces this via
  the p99 latency vs mean latency gap (`report.eval.ts:96`).
- Judge-error verdicts appear in the baseline distribution:
  `judge_error: 6` on diagnosis and `judge_error: 9` on
  recommendation (`eval/baseline.json` — verdictDistribution). The
  runner writes them as receipts (never throws) via
  `buildJudgmentPlaceholder` (`run.eval.ts:87-99`) so they're
  surfaced as a distinct outcome rather than lost. This is the
  **"the observability captured what the judge model can't handle"**
  case.

**Runbooks.** Not yet exercised as a `docs/runbooks/` folder. The
known alpha-server incident (revoked-token every ~5 min) is handled
inline by `lib/hooks/useReconnectPolicy.ts:33-45` — the fix is coded
into the client, not documented as a procedure.

## 8. debugging-observability-red-flags-audit

Ranked by consequence.

**Red flag 1 — no correlation ID separate from the session.** Two
concurrent requests from the same tab share a `sessionId` in the log
line. This is fine at the alpha scale; the day someone opens two
investigation tabs it becomes real work to disentangle their phase
logs. **Fix cost:** low (add a `req.headers.get('x-request-id') ??
crypto.randomUUID()` per handler, thread through the send helpers,
stamp on both routes' summary log — one afternoon).

**Red flag 2 — client-side trace is transient, split runs never reach
the receipt path.** `saveInvestigation` (`agent/route.ts:305`) only
fires on the combined run (`step == null`). The individual
diagnose/recommend runs from the browser flow live in
`sessionStorage` and die with the tab. A user reporting "the
diagnosis was wrong" cannot hand you a receipt unless they were on
the capture path. **Fix cost:** medium — writing per-step receipts
that align with the eval receipt shape.

**Red flag 3 — `console.log` is the only production ship path.**
Vercel scrapes stdout, but there's no structured shipping, no PII
redaction beyond OAuth tokens, no per-tenant fields. **Fix cost:**
medium if you retrofit pino + a shipper; high if you add OTel.
**When it matters:** the moment any real customer's data flows
through the logs.

**Red flag 4 — the p50/p95/p99 numbers depend on the reader running
the report.** No automatic run, no dashboard, no alert. The
"observability" is fully pull-based, not push. **Fix cost:** low if
you just cron `npm run eval:report > report.txt` in CI; higher if
you want a real dashboard.

**Red flag 5 — cache-tier tokens under-counted.** `pricing.ts:6-13`
documents this: `estimateAnthropicCost` uses only `inputTokens` and
`outputTokens`. `cache_read_input_tokens` are excluded from the input
count in aptkit's `model_usage` shape, so the report reads a **cost
upper bound**. Fine for a budget ceiling (conservative is the right
direction) but misleading if someone reads the receipt as a source of
truth for "what did this cost."

**Red flag 6 — judge_error is a real outcome, not a rare one.** The
committed baseline has 6/40 diagnosis judgments and 9/60
recommendation judgments as `judge_error`. That's ~15% of the signal
being unusable — the observability surfaces this honestly (it's in
`verdictDistribution`) but the fix belongs to prompt engineering, not
this guide.

**Red flag 7 — no PII redaction on Bloomreach EQL results.**
`redactSecrets` strips OAuth tokens (`transport.ts:66-76`) but the
tool-call results ship into `console.log(JSON.stringify({site, usage,
...}))` and into eval receipts unredacted. Customer emails,
customer IDs, and purchase details flow through unchanged.
**When it matters:** the moment a receipt for a real customer's data
ends up in a bug report or a public repo.

---

Cross-refs to the discovered patterns:

- `01-ndjson-live-trace.md` — lenses 1, 3, 5, 6
- `02-per-phase-request-summary.md` — lenses 3, 4, 5
- `03-capability-trace-receipts.md` — lenses 1, 5, 6, 7
- `04-baseline-and-regression-gate.md` — lenses 4, 7
- `05-fault-injecting-load-harness.md` — lenses 2, 6

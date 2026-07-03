# LLM observability

## Subtitle

Traces + spans + replay / capability-event telemetry — Industry standard.

## Zoom out, then zoom in

blooming's observability is built on **capability events** flowing through `AgentHooks.onCapabilityEvent` (`lib/agents/aptkit-adapters.ts`). Every model turn fires a `model_usage` event with per-turn token counts; every tool call fires `tool_call_start` and `tool_call_end`. These flow into per-case receipts. The receipts feed two consumers: `eval/report.eval.ts` (prints p50/p95/p99 latency + tokens + cost per case) and `eval/gate.eval.ts` (blocks on regression vs baseline).

```
  Zoom out — the observability pipeline

  ┌─ aptkit agent loop ──────────────────────────────────┐
  │  fires CapabilityEvent per turn:                     │
  │    model_started, model_finished, model_usage,       │
  │    tool_call_start, tool_call_end, text              │
  └───────────────────────┬──────────────────────────────┘
                          │
                          ▼
  ┌─ BloomingTraceSinkAdapter ★ ────────────────────────┐ ← we are here
  │  lib/agents/aptkit-adapters.ts                       │
  │  · forwards to AgentHooks.onCapabilityEvent           │
  │  · routes to onToolCall, onText, onToolResult         │
  └───────────────────────┬──────────────────────────────┘
                          │
      ┌───────────────────┼──────────────────────┐
      ▼                   ▼                      ▼
  UI stream          Eval receipts          Budget tracker
  (NDJSON events)    (json per case)         (lib/agents/budget)
```

Zoom in: one hook, three consumers, all fed by the same event stream.

## Structure pass

- **Layers:** agent event → hook → three consumers (UI, receipts, budget). Four bands.
- **Axis: consumer purpose.** UI: live visibility. Receipts: post-hoc analysis. Budget: pre-dispatch gate.
- **Seam:** the `onCapabilityEvent` hook — one function boundary, three uses.

## How it works

### Move 1 — the mental model

The three pillars of LLM telemetry, applied to blooming:

```
  Three pillars — how they map

  ┌─ Traces (per-request) ─────────────────────────────┐
  │  · which agent ran                                  │
  │  · total duration                                   │
  │  · total tokens / cost                              │
  │  · verdict per rubric                               │
  │  Lives in: eval/receipts/<runId>-<caseId>.json      │
  └────────────────────────────────────────────────────┘

  ┌─ Spans (per-turn) ─────────────────────────────────┐
  │  · one span per model_usage event                  │
  │  · one span per tool_call_end event                │
  │  Lives in: same receipt, indexed by turn            │
  └────────────────────────────────────────────────────┘

  ┌─ Replay (re-run with different prompt) ────────────┐
  │  goldens files are the deterministic input          │
  │  → same anomaly → new prompt → different diagnosis   │
  └────────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**The trace sink adapter.** `BloomingTraceSinkAdapter` in `lib/agents/aptkit-adapters.ts` — implements aptkit's `CapabilityTraceSink` port. On every event:

- Fires `hooks.onCapabilityEvent?.(event)` (the additive hook, added in Phase 2).
- Routes to `hooks.onText`, `hooks.onToolCall`, `hooks.onToolResult` for the UI stream.
- Feeds usage back into the `BudgetTracker` for the pre-dispatch gate.

**The eval receipt.** `eval/run.eval.ts` collects all `model_usage` events per phase (investigate, recommend), sums them with `summarizeUsage()` from aptkit, computes cost with `estimateAnthropicCost()` from `lib/agents/pricing.ts`, and writes a receipt like:

```
  eval/receipts/2026-07-03T04-08-28-644Z-01.json  (sketch)

  {
    "runId": "2026-07-03T04-08-28-644Z",
    "case": "01-conversion-drop-mobile-checkout",
    "signalClass": "has-signal",
    "durationMs": {
      "investigate": 49200,
      "diagnosisJudge": 37800,
      "recommend": 51100,
      "recommendationJudge": 91400,
      "total": 229500
    },
    "usage": {
      "diagnose": { "inputTokens": 47200, "outputTokens": 6100, "cost": 0.0334 },
      "recommend": { "inputTokens": 52800, "outputTokens": 7300, "cost": 0.0454 }
    },
    "diagnosisJudgment": { "verdict": "pass", "dimensions": {...} },
    "recommendationJudgments": [ {...}, {...}, {...} ]
  }
```

**The report.** `eval/report.eval.ts` reads all receipts for a run and prints:

```
  per-phase latency: diagnose 50s / d-judge 38s / recommend 51s
                     / r-judge 90s / total 225s (p50)
  per-case cost:     $0.09 agent-side (with caching)
  per-dim pass rates: root_cause_plausibility 75%, ...
```

**The gate.** `eval/gate.eval.ts` reads `eval/baseline.json` + the latest run's receipts, computes per-dim pass rate diffs, exits non-zero if any dim regressed > `GATE_MAX_REGRESSION` (default 10pp). Wired into CI as `npm run eval:gate` after `npm run eval`.

**The commited baseline.** `eval/baseline.json` — the reference run. RunId `2026-07-03T04-08-28-644Z`. Every future run compares against this. When a refactor legitimately improves quality, the baseline is updated intentionally, not silently.

Diagram of the observability pipeline:

```
  Observability — full pipeline

  ┌─ aptkit agent loop (per turn) ─────────────────────────┐
  │  fires: model_usage { inputTokens, outputTokens, ... }  │
  │         tool_call_start, tool_call_end                  │
  │         text                                             │
  └────────────────────────┬───────────────────────────────┘
                           │
                           ▼
  ┌─ BloomingTraceSinkAdapter ─────────────────────────────┐
  │  onCapabilityEvent(event) → hook.onCapabilityEvent?     │
  │  routes to onText / onToolCall / onToolResult           │
  └────────────────────────┬───────────────────────────────┘
                           │
      ┌────────────────────┼─────────────────────────┐
      ▼                    ▼                         ▼
  UI stream           Eval receipt              Budget tracker
  (via route          (eval/receipts/*.json)    (lib/agents/budget.ts)
   NDJSON encoder)                              (pre-dispatch check)
      │
      ▼
  StatusLog live
```

### Move 3 — the principle

Telemetry is a first-class product surface, not an afterthought. One hook, one event stream, three consumers. When the same event pipeline feeds the UI, the receipts, and the budget gate, you get consistency for free — the number the user sees, the number the report shows, and the number the gate enforces are all the same number.

## Primary diagram

```
  LLM observability in blooming — full frame

  ┌─ Event source: aptkit agent loop ──────────────────────┐
  │  model_usage per turn, tool_call_* per tool call        │
  └────────────────────┬───────────────────────────────────┘
                       │
                       ▼
  ┌─ BloomingTraceSinkAdapter (one seam) ──────────────────┐
  │  lib/agents/aptkit-adapters.ts                          │
  │  fires AgentHooks.onCapabilityEvent + granular hooks    │
  └────────────────────┬───────────────────────────────────┘
                       │
      ┌────────────────┼────────────────┬─────────────────┐
      ▼                ▼                ▼                 ▼
  Live UI          Eval receipt     Budget check     Cost report
  (route stream)   (per case)       (pre-dispatch)   (aggregate)

  Baseline: eval/baseline.json (runId 2026-07-03T04-08-28-644Z)
  Gate:     eval/gate.eval.ts (blocks on any dim regressing >10pp)
```

## Elaborate

The three-pillars framing (traces, spans, replay) comes from OpenTelemetry adapted to LLM concerns. Traditional APM tools (Datadog, New Relic) don't natively understand tokens or model IDs; LLM-specific tools (Langfuse, LangSmith, Phoenix/Arize, Helicone) do.

blooming chose to build in-house rather than depend on a hosted observability service because the receipts are the golden-set inputs — they need to be committable, replayable, and diffable in git. A hosted service would fragment ownership between "the eval" and "the observability."

Related: **02-eval-methods.md** (the judgments that land in receipts), **../01-llm-foundations/06-token-economics.md** (the cost math derived from receipt tokens).

## Project exercises

### B5.4 · Add a live cost dashboard reading from receipts

- **Exercise ID:** B5.4 (Case A — receipts are live; add a live UI)
- **What to build:** A page under `app/eval/` that reads `eval/baseline.json` and recent receipts and renders p50/p95/p99 latency + $ per case + per-dim pass rates.
- **Why it earns its place:** Turns markdown-file eval reports into a queryable surface. Same data, different consumer.
- **Files to touch:** New `app/eval/page.tsx`, new `app/api/eval/route.ts`, reuses `lib/agents/pricing.ts`.
- **Done when:** the page renders the current baseline's numbers and a small chart of pass-rate trend if multiple runs are available.
- **Estimated effort:** `1–2 days`.

## Interview defense

**Q: How do you know your agent's latency is stable?**

`eval/baseline.json` records per-phase p50/p95/p99 for the reference run. `eval/gate.eval.ts` compares the latest run to baseline and blocks if any dim regresses >10pp. Latency isn't gated on the same threshold (a slow model turn isn't a quality regression), but it *is* in the report. The load-bearing part: the observability pipeline is one hook, one event stream, three consumers — same numbers everywhere.

**Q: What if the judge fails mid-response?**

`judge_error` placeholder in the receipt. `eval/run.eval.ts` catches the parse error, records the failure, keeps going. The receipt is well-formed; the aggregate report shows the judge_error count as a signal. Empirically, `max_tokens = 4096` keeps the rate under 1%. If it climbed, I'd bump the cap.

## See also

- [02-eval-methods.md](02-eval-methods.md) — the judgments that produce receipt content.
- [../01-llm-foundations/06-token-economics.md](../01-llm-foundations/06-token-economics.md) — the cost math.
- [../06-production-serving/01-llm-caching.md](../06-production-serving/01-llm-caching.md) — where the cache_read count that saves money shows up.

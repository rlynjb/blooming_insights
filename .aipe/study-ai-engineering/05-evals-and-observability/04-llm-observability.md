# 04 — LLM observability

**Type:** Industry standard. Also called: LLM telemetry, agent tracing, eval infrastructure.

## Zoom out, then zoom in

Three pillars — traces, spans, replay. This codebase has all three, home-rolled around the eval receipt shape rather than Langfuse / LangSmith.

```
  Zoom out — the three pillars in this repo

  ┌─ Traces (per model call) ─────────────────────────────────────────┐
  │  every complete() logs {site, sessionId, usage}                    │
  │  CapabilityEvent 'model_usage' captured in eval trace              │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ Spans (per turn / tool call) ────────────────────────────────────┐
  │  CapabilityEvent stream: step, tool_call_start, tool_call_end     │
  │  BloomingTraceSinkAdapter forwards each event                      │
  │  onCapabilityEvent hook captures all for receipts                  │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ Replay ──────────────────────────────────────────────────────────┐
  │  Committed demo snapshots (lib/state/demo-*.json)                  │
  │  Replay same NDJSON events on every load                           │
  │  Eval receipts replay for report generation                        │
  │  ★ THIS CONCEPT ★                                                  │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. The eval receipt is the load-bearing artifact — one JSON file per (case, run) with usage, cost, tool calls, judgments, budget snapshot. The report (`eval/report.eval.ts`) reads receipts on disk and prints percentile latency + tokens/cost per phase.

## Structure pass

**Layers:**
- Outer: a run — 10 cases, one runId
- Middle: per-case receipts + per-phase timing
- Inner: per-turn CapabilityEvents

**Axis: what's persisted, what's ephemeral?**
- Persisted: receipts, baseline.json, calibration, demo snapshot
- Ephemeral: the running trace during an investigation

**Seam:** the CapabilityEvent stream. Above: consumers (eval, report, live UI). Below: AptKit's trace sink.

## How it works

### Move 1

You've written per-request telemetry (latency, status code, size). LLM observability is that, but the "request" is one full ReAct investigation and the "unit" is per-turn + per-tool.

```
  Three pillars (Langfuse et al.'s vocabulary)

  traces  — the per-request record: input, output, model, latency, cost
  spans   — sub-steps within a request: tool calls, reasoning steps
  replay  — re-running a saved trace with different code / prompts
```

### Move 2

**Trace capture — every model call.**

`AnthropicModelProviderAdapter.complete()` at `lib/agents/aptkit-adapters.ts:97-101`:

```typescript
console.log(JSON.stringify({
  site: this.logSite,
  sessionId: this.sessionId,
  usage: response.usage,
}));
```

Fires once per turn. Plus AptKit emits `CapabilityEvent 'model_usage'` on the same call, which flows through the trace sink to the eval receipt.

**Span capture — every reasoning step + tool call.**

`BloomingTraceSinkAdapter.emit()` at `lib/agents/aptkit-adapters.ts:157-184`. Handles three event types: `step` (reasoning), `tool_call_start`, `tool_call_end`. Fires hooks (`onText`, `onToolCall`, `onToolResult`) into the route/eval layer. **New in Phase 2**: also forwards every event via the `onCapabilityEvent` hook — no filtering, full raw stream.

**The eval receipt shape.**

`eval/run.eval.ts:341-395`. One JSON per (case, run):
- `runId`, `case`, `signalClass`, `intent`
- `durationMs`: per-phase (investigate, diagnosisJudge, recommend, recommendationJudge, total) + p50/p95/p99
- `model`: which model per stage
- `anomaly`: the input
- `diagnosisToolCalls` / `recommendationToolCalls`: what tools ran
- `usage`: per-phase `{inputTokens, outputTokens, turns, costUsd}` from `summarizeUsage` + `estimateAnthropicCost`
- `budget`: snapshot at the end + limit + `exceeded` flag
- `diagnosis`: the output
- `diagnosisJudgment`: the rubric result
- `recommendations` + `recommendationJudgments`: each rec's judgment

**The report — reads receipts, no model calls.**

`eval/report.eval.ts`. Zero cost (no LLM invocations). Reads all receipts for a runId, computes:
- Per-phase p50 / p95 / p99 / max
- Per-case cost breakdown
- Run totals (tokens, cost, aggregate time)
- Per-tool-call latency stats

Baseline numbers from `eval/baseline.json` (runId `2026-07-03T04-08-28-644Z`):
- Per-phase p50: diag 50s · d-judge 38s · rec 51s · r-judge 90s · total 225s
- Per-case cost: ~$0.09 agent-side (cached)
- Run total: $0.913 agent + ~$0.40 judge = ~$1.30

**Replay in two shapes.**

1. **Product demo replay.** `?demo=cached` serves the committed `lib/state/demo-insights.json` + `demo-investigations.json` as NDJSON, same events the live path emits. Instant, no auth.
2. **Eval receipt replay.** `eval/report.eval.ts` reads receipts and re-derives report metrics without re-running the agents. Zero cost.

Both replay the STREAMED EVENT contract (`AgentEvent` in `lib/mcp/events.ts`), which is why "the AgentEvent NDJSON contract must not change" (from project context).

### Move 3

Observability is trace + span + replay. This codebase built all three around one shape — the `CapabilityEvent` stream from AptKit's trace sink — and layered receipts / demo snapshots / report on top. No SaaS. No Langfuse. The build cost was one adapter (263 LOC in `aptkit-adapters.ts`) and one receipt schema; the ongoing operational cost is a `mkdir eval/receipts` and a `git commit`.

## Primary diagram

Full observability stack in this codebase.

```
  LLM observability — the pipeline

  ┌─ AptKit agent loop ───────────────────────────────────────────────┐
  │  emits CapabilityEvents:                                          │
  │    step, tool_call_start, tool_call_end, model_usage              │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ BloomingTraceSinkAdapter ──▼─────────────────────────────────────┐
  │  · forwards to hooks (onText, onToolCall, onToolResult)           │
  │  · forwards raw stream via onCapabilityEvent (Phase 2)             │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
  ┌─ Route hook ─┐   ┌─ Eval runner ─────┐   ┌─ Budget tracker ──┐
  │ writes NDJSON│   │ captures full     │   │ accumulates       │
  │ to stream    │   │ trace for receipt │   │ inputTokens etc.  │
  └──────┬───────┘   └──────┬────────────┘   └───────────────────┘
         │                  │
         ▼                  ▼
  ┌─ StatusLog ──┐   ┌─ receipt.json ──────────────────────────────┐
  │ live UI       │   │ per (case, run)                            │
  │ trace display │   │ · durationMs by phase                       │
  └───────────────┘   │ · usage.{diagnose,recommend}.costUsd        │
                      │ · toolCalls[]                               │
                      │ · diagnosis + judgment                      │
                      │ · budget snapshot                           │
                      └──────────┬──────────────────────────────────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
              eval/report   eval/baseline  eval/gate
              (p50/95/99)   (per-dim %)    (regression)
```

## Elaborate

The SaaS options (Langfuse, LangSmith, Braintrust, Phoenix/Arize, Helicone) offer this stack + cloud storage + dashboards + team collaboration. This codebase's home-rolled version is enough for a solo demo — receipts on disk, report on stdout, `git commit` for persistence. It scales to the point where multiple engineers or a small team need a shared dashboard; then adopting a SaaS is a straight port because the shape (traces + spans + replay) is standard.

## Project exercises

### Exercise — per-tool-call error rate dashboard

- **Exercise ID:** C3.4-A · Case A (concept exercised; extend).
- **What to build:** in `eval/report.eval.ts`, add a section: per-tool error rate over the last N runs. Reveals which tools fail most often — informs where to add retry logic or reshape the prompt.
- **Why it earns its place:** turns a raw stream into an operational surface. Interviewer signal: "I can tell you which tool is my weakest link in production."
- **Files to touch:** `eval/report.eval.ts` (add per-tool section, read multiple runs).
- **Done when:** report shows tool_name / total_calls / error_count / error_rate over the last 5 runs.
- **Estimated effort:** 1-4hr.

## Interview defense

**Q: How do you observe agent behavior?**

Three layers. First, per-call logging in the model provider adapter — every `complete()` logs usage. Second, `CapabilityEvent` stream from AptKit's trace sink — captured in eval receipts and streamed as NDJSON to the UI. Third, per-run receipts on disk (`eval/receipts/`), aggregated in `eval/report.eval.ts` for p50/p95/p99 latency and cost. Home-rolled, no SaaS.

**Q: Why not use Langfuse or LangSmith?**

Home-rolled hits the demo scale I need. Receipts on disk, report on stdout, `git commit` for persistence — that's enough for one person. If a team formed I'd port to Langfuse; the shape (traces + spans + replay) is standard, so the port is straight-forward.

**Q: What's the replay for?**

Two shapes. Product demo replay — `?demo=cached` serves committed NDJSON events without live agent runs. Eval report replay — `eval/report.eval.ts` reads receipts on disk and re-derives metrics without re-invoking the LLM. Both are zero-cost re-computations against captured state.

```
  replay use cases:
    · demo mode: instant "look at the agent working" without auth
    · eval report: recompute metrics without spending judge $
```

## See also

- `01-eval-set-types.md` — what feeds the receipts
- `02-eval-methods.md` — the rubric structure receipts persist
- `03-llm-as-judge-bias.md` — the calibration slice
- `eval/report.eval.ts` — the reader
- `lib/agents/aptkit-adapters.ts:149-184` — the trace sink adapter

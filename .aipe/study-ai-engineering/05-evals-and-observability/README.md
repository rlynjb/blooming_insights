# 05 · Evals and observability

The harness that keeps the agents honest. Live in this codebase, with real numbers and a committed baseline.

- [01-eval-set-types.md](01-eval-set-types.md) — 10 goldens across 4 signal classes.
- [02-eval-methods.md](02-eval-methods.md) — LLM-as-judge with two rubrics × 4 dimensions × 5-scale × 3 verdicts.
- [03-llm-as-judge-bias.md](03-llm-as-judge-bias.md) — position, verbosity, self-preference; blind calibration protocol (6/6 verdict, 24/24 within-1).
- [04-llm-observability.md](04-llm-observability.md) — `AgentHooks.onCapabilityEvent` + receipts pipeline; p50/p95/p99 + $ per case.

## The load-bearing files in this sub-section

- `eval/goldens/*.ts` — 10 golden cases (4 signal classes).
- `eval/rubrics/diagnosis-quality.ts` · `eval/rubrics/recommendation-quality.ts` — 4 dimensions each.
- `eval/run.eval.ts` — the harness.
- `eval/report.eval.ts` — observability report (p50/p95/p99 + cost).
- `eval/baseline.json` — committed reference for the regression gate.
- `eval/gate.eval.ts` — the regression gate (blocks if any dim drops >10pp).
- `lib/agents/aptkit-adapters.ts` — `BloomingTraceSinkAdapter` + `onCapabilityEvent` hook.

## The real numbers

Baseline runId `2026-07-03T04-08-28-644Z`:

- Per-phase p50 latency: diagnose 50s · diagnose-judge 38s · recommend 51s · recommend-judge 90s · total 225s
- Per-case cost: ~$0.09 agent-side (with caching) · ~$1.30 total for 10 cases
- Diagnosis pass rates: root_cause_plausibility 75% · evidence_grounding 50% · scope_coherence 75% · actionable_next_step 0%
- Recommendation pass rates: diagnosis_response 48% · feature_choice_fit 62% · step_actionability 100% · impact_realism 43%

The known-broken thing: cases 01 and 08 both propose "pause the A/B experiment" when the primary root cause is a payment processor. Failed by `diagnosis_response` (score 2).

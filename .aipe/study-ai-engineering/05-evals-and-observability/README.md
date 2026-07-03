# 05 — Evals and observability (LLM side)

The tier-2 story. The eval harness in `eval/` is the connective tissue of this repo's portfolio hardening — 10 goldens × 2 rubrics × 4 dims × 3 verdicts, per-case receipt, judge-error resilience, signal-class-aware gate, load harness, fault-injection decorator, regression gate.

## Files

- `01-eval-set-types.md` — golden / adversarial / regression sets. This repo has goldens; adversarial is Case B; regression is baseline.json.
- `02-eval-methods.md` — from exact-match to LLM-as-judge. This repo uses rubric-based LLM-as-judge.
- `03-llm-as-judge-bias.md` — position, verbosity, self-preference. Session-D calibration pilot measured Sonnet-vs-Haiku agreement.
- `04-llm-observability.md` — receipts, report, budget, calibration. What the eval harness surfaces.

## Anchor shape

LLM application engineering. Everything here is directly exercised in this codebase (Phase 1 eval harness through Phase 5 regression gate, shipped Weeks 2-4).

## Curriculum

Phase 3 — concepts C3.1-C3.12.

## Key numbers to anchor against

From committed `eval/baseline.json` (runId `2026-07-03T04-08-28-644Z`):
- 10 goldens across 4 signal classes (has-signal, partial-signal, no-signal, positive)
- Per-case ~$0.09 agent-side (cached), ~$1.30 for the full 10-case run
- Diagnosis dim pass rates: root_cause_plausibility 75%, evidence_grounding 50%, scope_coherence 75%, actionable_next_step 0%
- Recommendation dim pass rates: diagnosis_response 48%, feature_choice_fit 62%, step_actionability 100%, impact_realism 43%
- Session D pilot: verdict agreement 6/6 (100%), exact-match 13/24 (54%), within-1 24/24 (100%)

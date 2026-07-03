# ML features in this codebase

**This codebase has no classical ML features.** No trained model, no training pipeline, no feature engineering, no train/val/test split, no on-device inference. Every reasoning step in the system is an LLM call to Anthropic.

The rest of `08-machine-learning/` is generated per spec — the concept files teach the material as new ground and use Case B project exercises (curriculum Build items become the primary buildable target). None of them anchor to code that exists in this repo.

## Why include ML at all

Two reasons:

1. **Shape recognition.** The AI engineering study spec identifies three project shapes (LLM app engineering, prompt tooling, classical ML). Even when the studied codebase is squarely shape-1, the ML sub-sections teach concepts the reader may encounter in interview loops or in an adjacent role. Skipping them entirely would leave gaps in the curriculum.
2. **Adjacency to what IS here.** Anomaly monitoring, drift detection, calibration — these are ML-shaped concerns that show up in the LLM eval harness too. The judge-agreement calibration slice (`eval/calibration/`) is a small-scale version of the "is your labeled set trustworthy" question that classical ML lives by.

## Where LLM work touches ML-adjacent concepts

- **Anomaly monitoring.** The `MonitoringAgent` runs a fixed checklist of ecommerce anomaly categories and emits `Anomaly` objects when thresholds trip. This is anomaly detection — but rule-based (threshold on percent change) with an LLM narrating the finding, not a trained anomaly detector. See `09-ml-system-design-templates/02-anomaly-detection.md`.
- **Eval calibration.** The Session-D pilot compared a Sonnet judge with a Haiku judge on 6 cases: 6/6 verdict agreement, 13/24 exact-match dims, 24/24 within-1. This is inter-rater agreement, a classical ML measurement applied to LLM-as-judge. Files: `eval/calibration/agreement-*.json`, `eval/compute-agreement.eval.ts`.
- **Regression gate.** `eval/gate.eval.ts` compares candidate per-dim pass rates against a committed baseline. This is drift detection on eval scores — not on model weights or input features, but on model behavior.

## What would need to be built for the ML section to anchor to code

If the reader wanted to add real trained ML to this repo, the natural fit would be:

- A learned severity ranker on top of the anomaly monitor — features are `{metric, scope, magnitude, category, historical_frequency, affected_revenue}`, target is `{critical | warning | info}` labels backfilled from operator feedback in the demo snapshot. See Case B in `08-machine-learning/04-model-selection.md` and `05-class-imbalance.md`.
- A learned "was this diagnosis right" classifier — features from the diagnosis + tool-call trace, target is a human-labeled `{good | not good}` from a growing eval receipts corpus. This is where the retired session-D worksheet would grow into training data.

Both would fit shape-2 anomaly detection (`09-ml-system-design-templates/02-anomaly-detection.md`). Neither is built today.

# 08 — Machine Learning

**This codebase has no classical ML** (see `ml-features-in-this-codebase.md` at the root). Per spec: concepts that don't apply to this codebase's shape at all are skipped — no file generated. This directory holds files only for ML concepts with real adjacency to LLM app work:

- `01-supervised-pipeline.md` — the umbrella, taught as new ground. Adjacency: eval harness's train/val discipline is the same DNA.
- `08-confusion-matrices.md` — because the eval harness's per-dim scoring is a natural analogue.
- `09-calibration.md` — because LLM-as-judge calibration (this repo's Session-D pilot) is the same discipline applied to LLM output.
- `15-drift-detection.md` — because `eval/gate.eval.ts` regression detection is drift detection on rubric behavior.

Explicitly SKIPPED (per spec — don't apply to this codebase's shape):
- Feature engineering — no feature store, no model input
- Train/val/test split discipline — no training data set
- Model selection (LR vs GBT) — no model
- Class imbalance — no classifier
- Domain gap — no train/inference distribution split
- Transfer learning — no pretrained-model finetuning
- Recommender systems — no recommendations from a learned model
- Cold-start — no learned system to cold-start
- On-device inference — no on-device model
- Quantization — no model artifacts to quantize
- Training-run logging — no training runs
- Retraining pipelines — no retraining

The files present are the load-bearing curriculum concepts where adjacency to this repo IS meaningful — the LLM eval story reuses ML discipline (calibration, drift, per-class metrics) even though there's no classical ML.

## Curriculum

Phase 2C — subset of concepts C2C.1-C2C.13.

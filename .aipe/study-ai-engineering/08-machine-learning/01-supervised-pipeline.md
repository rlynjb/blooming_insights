# 01 — The supervised ML pipeline

**Type:** Industry standard. Also called: classical supervised learning, tabular ML pipeline.

## Zoom out, then zoom in

**Not exercised in this codebase.** Taught as new ground. The five-stage pipeline (data → features → splits → train → deploy) is where classical ML organizes its work.

```
  Zoom out — the supervised pipeline (not present in this repo)

  ┌─ Data ────► Features ────► Splits ────► Train ────► Deploy ────┐
  │ raw inputs   engineered    train/val/    trained     inference   │
  │ labeled      per-row        test          weights                 │
  │ examples     features                                            │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. What each stage owns and why the pipeline has this shape. Then bridge: even without ML in this repo, the discipline (data → measurement → deploy → drift check) recurs in the LLM eval story.

## Structure pass

Axis: what does each stage own?
- Data: labels, quality, coverage
- Features: what numbers the model sees (most of the work)
- Splits: train/val/test discipline (never same data in two splits)
- Training: model class, hyperparameters, loss
- Deploy: inference latency, model size, drift

**Seam:** every stage transition. Bad data at any stage propagates downstream and there's no fixing it in a later stage.

## How it works

### Move 1

You've built a data pipeline: `input → validate → transform → store → serve`. Same shape at ML scale, five stages.

```
  Supervised ML — five stages

  Data       →  Features    →  Splits     →  Train       →  Deploy
   │             │              │             │              │
   ▼             ▼              ▼             ▼              ▼
  raw+labels    engineered     train/val/    weights        inference
  quality       per-row        test          + metrics      + monitoring
  coverage      most work      discipline    hyperparams    drift
```

### Move 2

**Data.** Raw labeled examples. Quality (correct labels), coverage (do you have edge cases?), volume (is it enough to learn from?). "Most AI bugs are data bugs" — mislabeled examples, missing edge cases, class imbalance. If data is wrong, no model gets right.

**Features.** Convert raw data into numeric inputs. Domain-specific work. For classical ML, this is where the most effort goes — model choice contributes ~10% to quality, features ~60-80%. Modern deep learning learns features from raw data; classical ML requires hand-crafted features.

**Splits.** Train (learn from), validation (tune hyperparameters on), test (final measurement). Never same data in two splits. Split at the level of the unit your model will encounter as new — session level for session data, user level for user data. Random row-level split usually leaks signal across the boundary.

**Training.** Model class (LR, GBT, neural net), hyperparameters (learning rate, depth, epochs), loss function (cross-entropy, MSE). Iterate: train → measure on val → adjust. Test set is only touched once at the end for final measurement.

**Deploy.** Serve the trained weights. Inference latency (< 100ms for real-time, more for batch). Model size (matters for on-device). Drift monitoring (see `15-drift-detection.md`).

### Move 3

The pipeline discipline extends beyond ML. Data quality → measurement → deploy → drift is the shape of any measurement-driven system. This codebase's eval story has the same DNA — goldens (data), rubrics (features), receipts (train/val analogue), baseline.json (frozen deploy artifact), gate.eval.ts (drift detection).

## Primary diagram

```
  Supervised ML pipeline (industry standard)

  ┌─ Data ────────────────────────────────────────────────────────────┐
  │  labeled examples, quality-checked, covering edge cases            │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Feature engineering ───────▼─────────────────────────────────────┐
  │  raw → numeric features per row                                    │
  │  domain expertise; ~60-80% of quality                              │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Splits ────────────────────▼─────────────────────────────────────┐
  │  train / val / test — no leakage                                   │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Training ──────────────────▼─────────────────────────────────────┐
  │  fit model, tune hyperparameters on val                            │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Deploy ────────────────────▼─────────────────────────────────────┐
  │  inference serving, drift monitoring, retraining triggers          │
  └───────────────────────────────────────────────────────────────────┘

  Not present in this codebase — but the DISCIPLINE
  (data → measure → deploy → drift) applies to the LLM eval story
  (goldens → rubrics → baseline → gate).
```

## Elaborate

The five-stage pipeline is textbook (`Elements of Statistical Learning`, `Hands-On Machine Learning`). Real production pipelines have a lot more — feature stores, data versioning (DVC), experiment tracking (MLflow, W&B), model registries, CI/CD for models. The five-stage shape is the skeleton.

The single most important discipline: **never touch the test set until the end.** Any measurement on the test set that influences ANY decision effectively adds it to the training set. That failure mode ends product-quality measurements — team can't tell if the model is actually good or just tuned on the leaked test.

## Project exercises

### Exercise — build a learned severity ranker for anomalies

- **Exercise ID:** C2C.1-B · Case B (no ML in repo; curriculum-mapped build).
- **What to build:** the monitoring agent's severity is currently rule-based (thresholds on percent change). Replace with a learned classifier trained on operator-labeled data from `demo-*.json` snapshots. Features: `{metric_name, scope_length, magnitude, direction, category, historical_frequency}`. Target: `{critical, warning, info}` labels. Train a LightGBM classifier; deploy as a scoring step in monitoring.
- **Why it earns its place:** the smallest useful supervised-ML add. Interviewer signal: "I know the five stages and have built one end-to-end in a project that would normally not have ML."
- **Files to touch:** `lib/ml/` (new — data prep, feature extraction, training script), `lib/agents/monitoring.ts` (call the model).
- **Done when:** running monitoring shows severity labeling improved on a held-out set of ~50 operator-labeled anomalies.
- **Estimated effort:** 1 week.

## Interview defense

**Q: Have you built the classical ML pipeline?**

Not in this codebase. `blooming_insights` is a pure LLM app — every "reasoning" step is a Sonnet call, not a trained model. The five-stage pipeline (data → features → splits → train → deploy) is knowledge I have from curriculum work, not from shipping. The Case B exercise above (a learned severity ranker for anomalies) would be the smallest useful add to this codebase.

**Q: Where does the pipeline discipline show up here anyway?**

The eval story. Goldens (data), rubrics (features/measurement), per-run receipts (train + val analogue), `eval/baseline.json` (the frozen "deploy" artifact), `eval/gate.eval.ts` (drift detection). Same shape, applied to LLM behavior instead of tabular predictions.

```
  ML pipeline           This repo's eval pipeline
  ──────────           ─────────────────────
  data                 → goldens
  features             → rubrics + tool-call trace
  splits               → per-signal-class treatment
  train                → run the agents
  deploy artifact      → baseline.json
  drift detection      → gate.eval.ts
```

**Q: What's the load-bearing stage?**

Data + features. Model choice matters much less than most people think. A great model on bad features loses to a mediocre model on good features. Same shape in LLM apps — prompt engineering (analogous to feature engineering) matters more than model choice within a class (Sonnet vs Opus).

## See also

- `08-confusion-matrices.md` — the analogue to per-dim scoring
- `09-calibration.md` — LLM-judge calibration reuses this discipline
- `15-drift-detection.md` — the analogue to `eval/gate.eval.ts`
- `05-evals-and-observability/01-eval-set-types.md` — where the discipline lands in this codebase

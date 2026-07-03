# 15 — Drift detection

**Type:** Industry standard. Also called: distribution shift monitoring, model drift, concept drift.

## Zoom out, then zoom in

**Not exercised as classical ML drift.** But `eval/gate.eval.ts` is DRIFT DETECTION ON RUBRIC BEHAVIOR — the same discipline applied to LLM output quality.

```
  Zoom out — drift detection shape

  ┌─ Baseline (frozen reference) ─────────────────────────────────────┐
  │  per-dim pass rate over a golden set                              │
  │  eval/baseline.json                                                │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Candidate (new run) ───────▼─────────────────────────────────────┐
  │  same golden set, same rubric, new prompt/model                    │
  │  eval/receipts/*.json for the latest runId                         │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Gate (drift check) ────────▼─────────────────────────────────────┐
  │  compare per-dim pass rates                                        │
  │  fail if any drop by > GATE_MAX_REGRESSION (default 0.10)          │
  │  ★ THIS CONCEPT ★                                                  │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. Classical ML drift = production data distribution shifting from training distribution. This codebase's drift = LLM output quality drifting from baseline. Both use the same mechanism: baseline + candidate + threshold.

## Structure pass

Axis: what's shifting?
- Classical ML: feature distribution or class prior
- This codebase: per-dim pass rate on the same golden set

**Seam:** the baseline artifact. Above: the check compares against it. Below: it's just a JSON snapshot of a past run's aggregate.

## How it works

### Move 1

You've written a snapshot test. Same shape — freeze a "known good" snapshot; compare future runs; flag differences. Drift detection is snapshot testing on statistical properties.

```
  Drift detection — snapshot testing for distributions

  reference:  frozen baseline (dist / metrics / behavior)
  candidate:  fresh measurement
  compare:    diff along a chosen axis
  decision:   pass / fail based on threshold
```

### Move 2

**Classical ML drift detection.**

Compare production feature distribution against training feature distribution. Population Stability Index (PSI) is the standard measure. PSI < 0.1 = no significant change. PSI 0.1-0.2 = moderate, investigate. PSI > 0.2 = significant, consider retraining.

Formula: `PSI = Σ (prod_pct - train_pct) × ln(prod_pct / train_pct)` over bucketed histograms.

**This codebase's drift detection — `eval/gate.eval.ts`.**

Compares candidate run's per-dim pass rate against `eval/baseline.json`'s baseline pass rate. Fails if any dim drops by > `GATE_MAX_REGRESSION` (default 0.10, i.e. 10 percentage points).

- Baseline: computed by `eval/baseline.eval.ts` and committed to `eval/baseline.json`.
- Candidate: the latest receipts in `eval/receipts/` (or a specified RUN_ID).
- Comparison: per-dim.
- Threshold: 10 percentage points regression = block.

Same shape as PSI — a "how much has this distribution shifted" measure with a decision threshold.

**Why this shape.**

Because the failure mode is prompt regression. Change the prompt; new dim drops. Baseline as a frozen snapshot + gate as a comparison catches this in CI before merge.

**What it doesn't catch.**

- Gradual drift over MANY small changes. Each change passes the gate individually; the cumulative effect degrades quality slowly. Mitigation: periodically re-baseline against a "known good" run.
- Improvement drift — a big improvement in one dim can mask a small regression in another. Because the gate is per-dim, this is handled.
- Judge drift — if the LLM judge itself changes behavior, the numbers change without the agent's actual quality changing. Mitigation: judge model + rubric are pinned; changes to either require re-baselining.

### Move 3

Drift detection is snapshot testing on aggregates. The mechanism (frozen baseline + fresh measurement + threshold decision) is the same whether the aggregate is a feature distribution (classical ML) or a rubric pass rate (LLM eval). This codebase applies it to the LLM eval story.

## Primary diagram

```
  Drift detection in this repo — eval/gate.eval.ts

  ┌─ Baseline (committed) ────────────────────────────────────────────┐
  │  eval/baseline.json (runId 2026-07-03T04-08-28-644Z)               │
  │                                                                   │
  │  diagnosis pass rates:                                             │
  │    root_cause_plausibility: 0.75                                   │
  │    evidence_grounding:      0.50                                   │
  │    scope_coherence:         0.75                                   │
  │    actionable_next_step:    0.00                                   │
  │  recommendation pass rates: {...}                                  │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Candidate (latest run) ────▼─────────────────────────────────────┐
  │  computeBaseline() over eval/receipts/*.json                       │
  │  (same math as baseline generation)                                │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Gate ──────────────────────▼─────────────────────────────────────┐
  │  for each dim:                                                     │
  │    regression = baseline_rate - candidate_rate                     │
  │    if regression > GATE_MAX_REGRESSION (0.10):                     │
  │      FAIL                                                          │
  │                                                                   │
  │  Wire into CI: `npm run eval && npm run eval:gate`                 │
  │  Exits non-zero on regression → blocks PR                          │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

Classical ML drift detection includes: PSI for feature distributions, KL divergence for probability distributions, Kolmogorov-Smirnov test for continuous distributions, chi-squared for categorical. All measure "how different are these two distributions?"

LLM eval drift is younger as a field. Regression gates against a baseline (this repo's approach) are becoming standard in mature LLM ops setups. Braintrust and W&B both offer this out of the box.

## Project exercises

### Exercise — trend visualization over multiple baselines

- **Exercise ID:** C2C.15-A · Case A (concept exercised; extend).
- **What to build:** track baseline.json across time (baseline-v1, baseline-v2, ...). Extend `eval/report.eval.ts` to plot per-dim pass rate as a time series across baselines. Reveals gradual drift the gate misses.
- **Why it earns its place:** the gate catches point regressions; a trend catches slow drift. Interviewer signal: "my gate catches single-PR drops; my trend catches slow decay."
- **Files to touch:** `eval/baseline-history/` (new folder), `eval/report.eval.ts` (add trend section).
- **Done when:** report shows per-dim trend across the last N baselines.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: Do you detect drift?**

Yes, applied to LLM output quality rather than classical ML. `eval/gate.eval.ts` compares a candidate run's per-dim pass rates against a committed baseline (`eval/baseline.json`). Fails if any dim regresses by > 10 percentage points. Wire it into CI as `npm run eval && npm run eval:gate` — the gate exits non-zero and blocks the PR.

**Q: What's the analogue in classical ML?**

PSI on feature distributions. Bucket the features, compare production distribution to training distribution, threshold at 0.1-0.2. Same discipline — frozen baseline, fresh measurement, threshold decision. Different mathematical shape (PSI vs percentage-point difference) because the measured quantity is different.

**Q: What doesn't your gate catch?**

Slow cumulative drift across many small changes. Each PR passes because each regression is under 10pp; the cumulative regression across 20 PRs is 40pp. Mitigation: periodically re-baseline against a "known good" run + track a trend across baselines (Case A exercise above).

```
  gate catches:  single-PR regression > 10pp per dim
  gate misses:   slow drift across many PRs each under threshold
  → mitigation:  periodic re-baseline + trend visualization
```

## See also

- `01-supervised-pipeline.md` — the analog discipline
- `09-calibration.md` — the discipline that keeps the judge stable
- `05-evals-and-observability/02-eval-methods.md` — the rubric the gate compares
- `eval/gate.eval.ts` — the gate code
- `eval/baseline.json` — the baseline

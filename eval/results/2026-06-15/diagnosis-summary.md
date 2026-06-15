# Diagnosis eval — 2026-06-15 (K=10)

Run with Sonnet 4.6 (agent + judge), OlistDataSource live. Path C: diagnostic agent invoked directly on each seeded anomaly's metadata, bypassing upstream detection.

## Aggregate

| Metric                 | Value           |
|---|---|
| Pass rate (mean)       | 53.3% |
| Mean total score       | 6.37 / 9 |
| Per-criterion (mean)   | |
|   hypothesis           | 1.53 / 2 |
|   evidence             | 2.00 / 2 |
|   sizing               | 1.43 / 2 |
|   calibration          | 0.03 / 1 |
|   fabrication          | 1.37 / 2 |

## Per anomaly

| Anomaly                | Pass rate | Mean score |
|---|---|---|
| electronics-spike-w2 | 6/10 (60.0%) | 6.60 |
| sp-revenue-drop-w4 | 0/10 (0.0%) | 4.60 |
| voucher-dropoff-w10-on | 10/10 (100.0%) | 7.90 |

## Spot-check (judge calibration)

Reviewed 8 judge outputs manually (stratified sample — 2 per anomaly: lowest- and highest-scored within each, plus one mid-pack from electronics and SP):

| Anomaly | Run | Judge total | My total | Agree? |
|---|---|---|---|---|
| electronics-spike-w2 | 1  | 6 FAIL | 6 FAIL | yes |
| electronics-spike-w2 | 6  | 5 FAIL | 5 FAIL | yes |
| electronics-spike-w2 | 10 | 8 PASS | 8 PASS | yes |
| sp-revenue-drop-w4   | 1  | 6 FAIL | 6 FAIL | yes |
| sp-revenue-drop-w4   | 5  | 3 FAIL | 3 FAIL | yes |
| sp-revenue-drop-w4   | 7  | 6 FAIL | 6 FAIL | yes |
| voucher-dropoff-w10-on | 1  | 8 PASS | 8 PASS | yes |
| voucher-dropoff-w10-on | 10 | 7 PASS | 7 PASS | yes |

**Agreement rate: 8/8 = 100%.**

Per-criterion observations:

- **Calibration (judge mean 0.03 / 1):** the judge is reading the agent's
  `confidence: high` field + "best explained by" framing as overclaiming
  almost every time. This is a true reading of the rubric, but it also
  means the calibration criterion is effectively binary — every candidate
  with `confidence: high` scores 0. That's an agent-side issue (the
  diagnostic prompt's confidence-derivation logic emits "high" too
  liberally), not a judge bias. Calibration could be tightened either by
  loosening the rubric ("acceptable hedging within `confidence: medium`")
  or by tightening the agent's confidence-derivation. Either way the
  current 0.03/1 represents a real signal, not a judge artifact.

- **Sizing (judge mean 1.43 / 2):** the judge correctly anchors to the
  seeded multiplier — ground truth -30% / +150% / -95% — and penalizes
  diagnoses that report the raw pct_change the tool returns (e.g.
  +14,055% for electronics, from baseline_avg=4.2 vs 588 raw counts)
  when that figure diverges from the seeded multiplier. This is in
  spec but reveals an interesting tension: the seed boosters CAN produce
  raw multipliers far above the headline `_generator.value`, so the
  agent's number is arithmetically correct vs the data while still being
  "wrong" vs the seeded intent. Worth surfacing as a finding (see
  honest notes).

- **Hypothesis on sp-revenue-drop-w4 (judge mean 0.7 / 2):** the agent
  consistently identifies "Dec 8 electronics spike inflated the SP
  baseline → Dec 22 -30% is a baseline-contamination artifact, not a
  real drop." This is a REAL phenomenon in the seeded data (the
  electronics-spike-w2 seeded anomaly does inflate baselines downstream
  via its SP boosters), and the agent's reasoning is locally correct.
  But the seeded GROUND TRUTH for sp-revenue-drop-w4 IS a real -30%
  drop (multiplier=0.7 applied to SP orders in week 4). So the agent
  is right about one effect (baseline contamination is real) while
  being wrong about which effect drives the headline drop. The judge
  scores hyp=1 ("right area, wrong driver") consistently for these.
  Manual agreement.

- **Fabrication (judge mean 1.37 / 2):** the judge catches BRL unit
  misquotes (cents stored as integer, agent narrates as Reais) every
  time. This is a real and consistent agent-side bug.


Judge model: claude-sonnet-4-6
Total runtime: 36:11

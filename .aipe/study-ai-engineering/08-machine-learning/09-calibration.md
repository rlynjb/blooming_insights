# 09 — Calibration

**Type:** Industry standard. Also called: reliability, probability calibration, judge calibration.

## Zoom out, then zoom in

**Not exercised as classical ML.** But the Session-D LLM-judge calibration pilot exercises the same discipline applied to LLM output.

## Structure pass

Axis: does the reported confidence match the actual right-rate?
- Well-calibrated: when the system says 70% confident, it's right 70% of the time
- Overconfident: system says 90%, is right 60%
- Underconfident: system says 40%, is right 70%

## How it works

### Move 1

You've seen a weather forecast say "80% chance of rain" and had it be right most of the time. Calibration is that reliability property, measured.

```
  Reliability diagram

    1.0 │              .            ← perfect calibration line
        │            .
        │          .  ●             ← measured points
    0.8 │        .   ●
        │      .
        │    .       ●
    0.6 │  .
        │.       ●
    0.4 │    ●
        │
    0.2 │
        │
    0.0 └───────────────────────►
        0.0    0.4    0.8   1.0
          Predicted probability

  ● = actual frequency for each prediction bucket.
  Below the line = overconfident; above = underconfident.
```

### Move 2

**Classical ML calibration.** Predict probabilities; bucket them; check actual frequency per bucket. A well-calibrated model says 70% when the actual frequency is 70%. Post-hoc calibration fixes: Platt scaling (fits a sigmoid to the raw scores), isotonic regression (fits a monotonic step function).

**When it matters in classical ML.** Anywhere downstream uses the probability, not just the class label. Thresholding decisions, ranking, expected-value computations.

**In this codebase's LLM eval — the Session-D pilot.**

The Session-D calibration slice measured whether the LLM judge's verdicts are reliable across a different judge (Sonnet vs Haiku). Same discipline applied to a different signal.

- 6 goldens judged by both Sonnet-judge and Haiku-judge (both at temp 0)
- Verdict agreement: 6/6 (100%)
- Exact-match dims: 13/24 (54%)
- Within-1 dims: 24/24 (100%)

Interpretation: at the VERDICT level, the judge is calibrated (reliable across judges). At the DIM-EXACT-MATCH level, less so — one judge says 4, the other says 3 on the same output. The "within-1" property (24/24) means neither judge is more than 1 point off from the other; there are no wild disagreements.

**What "calibration" means in this LLM-judge context.**

Not "when the judge says 70%, is it right 70%." Instead: "when two independent judges score the same output, do they agree?" That's a different kind of reliability — inter-rater agreement, related to but not identical to probability calibration. Both are asking "can I trust this scored value?" The mechanism is different.

**What this repo could add for a strict calibration test.**

Human-labeled ground truth on a slice of golden cases. Compare the LLM judge's verdict to the human's. Measure verdict agreement (Cohen's κ) or per-dim agreement. Would establish absolute reliability, not just relative-across-judges. Case B.

### Move 3

Calibration is asking "how much can I trust the number." In classical ML that's a probability question; in LLM eval it's an inter-rater agreement question. Both ways of measuring reliability. This codebase measures the LLM-judge version (Session-D) but not the strict-calibration version (LLM vs human).

## Primary diagram

```
  Session D LLM-judge calibration slice

  ┌─ 6 goldens ───────────────────────────────────────────────────────┐
  │                                                                   │
  │  each judged by both Sonnet-judge and Haiku-judge (temp 0)         │
  │                                                                   │
  │  verdict agreement:       6/6   (100%)   → gate-safe               │
  │  exact-match dims:       13/24  (54%)    → dim-precision noisy    │
  │  within-1 dims:          24/24  (100%)   → no wild disagreements   │
  │                                                                   │
  │  interpretation:                                                  │
  │  · use for gating on verdict-level regression: SAFE                │
  │  · use for gating on fractional dim differences: NOT SAFE          │
  │  · use for tracking dim regressions ≥ 2: SAFE                      │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

Classical ML calibration is a well-developed area. Reliability diagrams, Brier score, log loss, expected calibration error (ECE). Post-hoc calibration methods (Platt, isotonic, temperature scaling on neural nets).

LLM-judge calibration is less mature as a research area. Best current practice: cross-model agreement (this repo's approach) plus human-labeled sanity checks. Mature LLM eval platforms (Braintrust, Weights & Biases) offer both.

## Project exercises

### Exercise — human-labeled ground truth for judge calibration

- **Exercise ID:** C2C.9-B · Case B (LLM-judge calibration done; absolute-truth calibration not).
- **What to build:** hand-label 5 diagnosis judgments with per-dim scores + verdict. Compare LLM judge's scores against yours. If judge exact-match rate is < 60% or verdict-match rate is < 100%, that's a signal the rubric is ambiguous or the judge is biased.
- **Why it earns its place:** the strict-calibration test the Session-D pilot doesn't do. Interviewer signal: "I compared my LLM judge to human ground truth on a slice; here's the agreement rate."
- **Files to touch:** `eval/calibration/human-labeled.json` (new), `eval/compute-human-agreement.eval.ts` (new).
- **Done when:** hand-labeled slice + agreement metric reported.
- **Estimated effort:** 1-2 days (labeling is the slow part).

## Interview defense

**Q: Have you calibrated your LLM judge?**

Partially. Session-D pilot ran Sonnet-judge vs Haiku-judge on 6 goldens: verdict agreement 100%, exact-match dims 54%, within-1 dims 100%. That's cross-model reliability — safe for verdict-level gating, not for fractional-dim comparison. What I haven't done is calibrate against HUMAN ground truth; that's Case B.

**Q: Why cross-model instead of human?**

Because human labeling is slow at the scale I need (10 goldens × 8 dims × N runs). Cross-model gave me a fast first pass on "is the judge behavior stable enough to trust for gating." Human calibration is the follow-up — small slice, ~5 cases hand-labeled to compare against.

**Q: What would you do if human agreement was much lower than cross-model?**

That would signal shared bias — both LLM judges wrong the same way. I'd rewrite the rubric with sharper score-boundary descriptions to reduce ambiguity, or split a dim that's mixing multiple concepts. Then re-measure both cross-model and human agreement.

```
  Cross-model calibration (this repo):
    · fast, cheap, catches per-judge randomness
    · misses shared bias

  Human calibration (Case B):
    · slow, expensive, catches shared bias
    · needed slice: ~5 cases hand-labeled
```

## See also

- `05-evals-and-observability/03-llm-as-judge-bias.md` — biases calibration measures
- `08-confusion-matrices.md` — related per-dim discipline
- `eval/calibration/` — the pilot artifacts

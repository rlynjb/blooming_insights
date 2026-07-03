# 08 — Confusion matrices

**Type:** Industry standard. Also called: per-class error breakdown, misclassification analysis.

## Zoom out, then zoom in

**Not exercised as classical ML in this codebase.** But the RUBRIC per-dim breakdown (`eval/run.eval.ts:479-510`) is structurally analogous — an "actual vs predicted" table that reveals WHERE the errors concentrate.

## Structure pass

Axis: what does an aggregate metric hide?
- Overall accuracy: hides class-specific weaknesses
- Confusion matrix: reveals which classes are confused with which
- Per-dim rubric breakdown: reveals which dims fail across the golden set

## How it works

### Move 1

You've computed a "pass rate" (X/Y). It hid the fact that all the failures were on one specific input class. A confusion matrix (or per-dim breakdown) makes that visible.

```
  Confusion matrix

              Predicted →
            good  flare  depth  arch  sag
  Actual ↓
  good      920    20     8      2     0
  flare     10     18     2      0     0
  depth      4      1    10      0     0
  arch       1      0     1      1     0
  sag        0      0     0      1     1

  Diagonal = correct. Off-diagonal = errors. Overall accuracy 95%
  hides that "arch" recall is 33% and "sag" recall is 50%.
```

### Move 2

**In classical ML.** Actual class on rows, predicted on columns. Diagonal cells = correct. Off-diagonal = errors. Per-class metrics derive from it: precision = TP / (TP + FP), recall = TP / (TP + FN), F1 = harmonic mean.

**Confusion matrices in this codebase's eval.**

`eval/run.eval.ts:479-524` computes a per-dim per-score distribution across all judgments:

```
  DIAGNOSIS pass rate (score ≥ 4)
  ─────────────────────────────────────
    root_cause_plausibility        3/4  ( 75%)   dist [1:0 2:1 3:0 4:3 5:0]
    evidence_grounding             2/4  ( 50%)   dist [1:0 2:1 3:1 4:0 5:2]
    scope_coherence                3/4  ( 75%)   dist [1:0 2:1 3:0 4:3 5:0]
    actionable_next_step           0/4  (  0%)   dist [1:0 2:0 3:4 4:0 5:0]
```

Same shape as a confusion matrix — dim × score distribution. Reveals that `actionable_next_step` is 100% stuck at score 3, not evenly split. That's an actionable signal for prompt improvement (the model produces middling next steps every time; needs prompt guidance to name specific tools/queries).

**What it reveals that aggregate hides.**

If we only had "overall pass rate = 40%" we couldn't tell WHICH dim is failing. The per-dim view says `actionable_next_step` is the load-bearing failure mode; the others are fine. That prioritization is the confusion matrix's whole point.

### Move 3

Break aggregates down along the dimension that reveals the failure mode. In classical ML, that's class × class. In this codebase's LLM eval, that's dim × score. Same discipline; same value.

## Primary diagram

```
  This repo's dim × score breakdown (from run.eval.ts afterAll)

  ┌─ per-dim across 10 goldens ───────────────────────────────────────┐
  │                                                                   │
  │  dim                        pass_rate    score distribution        │
  │  root_cause_plausibility    75%          [1:0 2:1 3:0 4:3 5:0]     │
  │  evidence_grounding         50%          [1:0 2:1 3:1 4:0 5:2]     │
  │  scope_coherence            75%          [1:0 2:1 3:0 4:3 5:0]     │
  │  actionable_next_step       0%           [1:0 2:0 3:4 4:0 5:0] ← stuck │
  │                                                                   │
  │  reveals: actionable_next_step ALWAYS scores 3.                    │
  │  interpretation: model produces middling next steps every time.    │
  │  action: rewrite the prompt to force specific tool/query naming.   │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

The confusion matrix is classical stats vocabulary. F1 vs macro-F1 vs weighted-F1: micro/weighted rolls up by class size, macro treats classes equally. On imbalanced data, macro-F1 catches "the rare classes are broken" that weighted-F1 hides (see `05-class-imbalance.md` in the standard ML curriculum, but not present in this codebase's file set).

Per-dim rubric breakdowns are the analog for LLM evals. The mechanism (break aggregate down along a meaningful axis to reveal failure structure) is identical.

## Project exercises

### Exercise — confusion matrix on the diagnosis judge across signal classes

- **Exercise ID:** C2C.8-A · Case A (adjacency exercised; extend).
- **What to build:** across the 10-case receipts, compute a matrix: rows = signal_class × dim, columns = score buckets 1-5. Reveals whether score distributions differ by signal class (e.g. does the judge score `evidence_grounding` differently on no-signal cases?).
- **Why it earns its place:** turns the confusion-matrix discipline onto this repo's actual data. Interviewer signal: "I know how the judge behaves per signal class, not just in aggregate."
- **Files to touch:** `eval/report.eval.ts` (add cross-tab section).
- **Done when:** report shows a signal-class × dim × score cross-tab.
- **Estimated effort:** 1-4hr.

## Interview defense

**Q: What's a confusion matrix good for?**

Revealing WHERE errors concentrate. Overall accuracy of 95% could mean "great model" or "the rare class is completely broken." The matrix shows you which classes are being confused with which — which lets you decide "we need more training data on class X" or "the model's decision boundary is off on Y."

**Q: Where does this show up in your LLM eval?**

`eval/run.eval.ts:479-524`. Per-dim × per-score distribution across all judgments. In the committed baseline, `actionable_next_step` scored 3 on ALL 4 goldens that got that far — that's a distribution, not just a "40% failing" aggregate. Tells me the prompt is producing middling next steps consistently, which is a specific problem to fix.

**Q: What's the analogue to per-class precision/recall in your eval?**

Per-dim pass rate (score ≥ 4). Precision-analogue: of times this dim scored ≥ 4, how often does the diagnosis actually help. Recall-analogue: of good diagnoses, how often does this dim score ≥ 4. I don't compute the human-labeled version because I don't have ground truth beyond the golden's `knownCorrect` guidance — but the shape is there.

## See also

- `09-calibration.md` — related discipline
- `05-evals-and-observability/02-eval-methods.md` — where the rubric breakdown lives
- `eval/run.eval.ts:479-524` — the breakdown code

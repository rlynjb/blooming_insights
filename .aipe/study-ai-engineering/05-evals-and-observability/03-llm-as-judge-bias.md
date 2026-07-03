# LLM-as-judge bias

## Subtitle

Position / verbosity / self-preference bias — Industry standard.

## Zoom out, then zoom in

LLM-as-judge is cheap and scalable, but biased. Three known biases: **position** (judge prefers whichever variant appears first), **verbosity** (judge prefers longer responses regardless of quality), **self-preference** (judge prefers outputs from its own model family). Knowing them lets you design around them. blooming's blind calibration protocol (Session D pilot) measured judge-vs-human agreement: verdict 6/6, exact score 13/24 (54%), within-1-score 24/24 (100%). That's what makes the eval numbers defensible.

```
  Zoom out — where bias mitigation lives

  ┌─ Rubric definition ─────────────────────────────────┐
  │  eval/rubrics/*.ts                                   │
  │  · specific dimensions (not vague)                   │
  │  · anchored scale descriptions                       │
  │  · verbosity not explicit in prompt                  │
  └───────────────────────┬──────────────────────────────┘
                          │
                          ▼
  ┌─ Judge harness ★ ────────────────────────────────────┐ ← we are here
  │  · RubricJudge (from @aptkit/core)                   │
  │  · Sonnet judge, same family as agents (self-prefer  │
  │    risk, addressed by calibration)                   │
  └───────────────────────┬──────────────────────────────┘
                          │
                          ▼
  ┌─ Blind calibration ──────────────────────────────────┐
  │  Session D pilot: verdict 6/6 agreement,             │
  │  exact score 13/24 (54%), within-1 24/24 (100%)      │
  └──────────────────────────────────────────────────────┘
```

Zoom in: calibration is the proof that the judge is doing what you think it is.

## Structure pass

- **Layers:** bias source → mitigation → measured agreement → committed baseline. Four bands.
- **Axis: trust.** Each mitigation raises trust in judge scores. Calibration numbers make trust legible.
- **Seam:** the calibration protocol. Every rubric change should pass calibration before entering CI.

## How it works

### Move 1 — the mental model

Three biases and their fixes:

```
  Three judge biases — sketched

  ┌─ Position bias ───────────────────────────────────┐
  │  judge prefers whichever variant is listed first  │
  │  Fix: randomize order per pair                    │
  └────────────────────────────────────────────────────┘

  ┌─ Verbosity bias ──────────────────────────────────┐
  │  judge prefers longer responses                    │
  │  Fix: cap length OR include length as a dim being  │
  │        scored (so length becomes signal, not noise)│
  └────────────────────────────────────────────────────┘

  ┌─ Self-preference ─────────────────────────────────┐
  │  judge prefers outputs from its own model family   │
  │  Fix: use a different model family as judge OR     │
  │        calibrate against blind human scoring        │
  └────────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Position bias.** Doesn't apply to blooming's rubric evals — each rubric judgment scores *one* output, not two side-by-side. Would apply if `B5.2` (pairwise eval) lands; the fix there is randomizing which variant is labeled "A" vs "B" per case.

**Verbosity bias.** Blooming's rubrics have `step_actionability` and `impact_realism` in the recommendation rubric, and `evidence_grounding` in the diagnosis rubric — dimensions that naturally reward *specificity*, not length. A long-but-vague answer scores 2; a short-but-specific one scores 4. Explicit design choice.

**Self-preference bias.** The biggest risk in blooming — Sonnet judges Sonnet output. Not addressed by using a different judge model (which would drop the risk); addressed by **calibration**. The blind protocol: score a subset of outputs with the judge, then score the same outputs blind (human), then compare distributions.

**The blind calibration protocol.** `eval/calibration/` folder holds the artifacts:

- Take a small set of case outputs (Session D pilot used 6 cases = 6 diagnoses + 18 recs = 24 dimension-judgments).
- Have a human blind-score them against the rubric (no judge scores visible).
- Have the judge score them (the normal path).
- Compare: verdict agreement, exact-score agreement, within-1-score agreement.

Session D pilot results:

```
  Session D blind calibration — pilot results

  verdict agreement:          6 / 6      (100%)
  exact score agreement:     13 / 24     (54%)
  within-1-score agreement:  24 / 24     (100%)
```

100% verdict agreement is strong — the judge's pass/fail calls match the human's. 54% exact-score is moderate — judge and human sometimes disagree on 3 vs 4, but never disagree on 2 vs 5. 100% within-1 confirms the noise is bounded.

**Judge-error resilience.** Distinct from bias. When the judge fails to emit valid JSON (max_tokens hit mid-response), the receipt records `judge_error` instead of crashing. `max_tokens = 4096` was tuned to make this <1% of judgments (see **02-eval-methods.md**).

Diagram of the calibration process:

```
  Blind calibration — one round

  6 diagnosis outputs + 18 rec outputs = 24 judgment items
    │
    ├──────────────────────┐
    ▼                      ▼
  human blind scores    judge scores
  each item             each item
    │                      │
    └──────────┬───────────┘
               │
               ▼
  compare distributions:
    verdict-level:     100% match  (6/6)
    exact-score:        54% match  (13/24)
    within-1-score:    100% match  (24/24)

  interpretation:
    judge is calibrated for pass/fail decisions
    judge has bounded noise on granular scores
    the eval numbers are trustworthy at verdict level
```

### Move 3 — the principle

LLM-as-judge scales but biases. Rubric design (specific dimensions, anchored scales) reduces one class of bias. Blind calibration measures the residual noise and makes it legible. Never trust judge scores without calibration; calibration is the artifact that makes them defensible.

## Primary diagram

```
  Judge bias + mitigations in blooming — full frame

  ┌─ Rubric design ─────────────────────────────────────┐
  │  · specific dimensions                               │
  │  · anchored scale descriptions (1-5 with text)       │
  │  · dimensions that reward specificity, not length    │
  │    (mitigates verbosity bias by design)              │
  └───────────────────────┬─────────────────────────────┘
                          │
                          ▼
  ┌─ Judge model choice ────────────────────────────────┐
  │  Sonnet 4.6 (same family as agents)                  │
  │  · known self-preference risk                        │
  │  · mitigated by calibration, not by different judge  │
  └───────────────────────┬─────────────────────────────┘
                          │
                          ▼
  ┌─ Blind calibration protocol (LIVE) ─────────────────┐
  │  Session D pilot:                                    │
  │    verdict 6/6 · exact 13/24 · within-1 24/24        │
  │  → verdict-level trust is high                       │
  │  → per-dim scores have bounded noise                 │
  └───────────────────────┬─────────────────────────────┘
                          │
                          ▼
  ┌─ Judge-error resilience (LIVE) ─────────────────────┐
  │  max_tokens = 4096 (bumped from default)             │
  │  on parse fail: receipt records judge_error          │
  │  observed rate: <1% of judgments                     │
  └─────────────────────────────────────────────────────┘
```

## Elaborate

The three biases are well-established (Zheng et al. 2023 "Judging LLM-as-a-Judge with MT-Bench" enumerates them and measures effect sizes). Calibration is the industry-standard mitigation for the residual — even a same-family judge can be defensible if calibrated against blind humans.

Cross-family judging (using Claude to judge GPT-4, or vice versa) can reduce self-preference but introduces its own inconsistency across judge upgrades. Same-family + calibration is the pragmatic tradeoff blooming makes.

Related: **02-eval-methods.md** (the rubric shape), **04-llm-observability.md** (how bias-relevant metrics land in receipts).

## Project exercises

### B5.3 · Expand calibration to the full 10-case set

- **Exercise ID:** B5.3 (Case A — pilot exists; expand)
- **What to build:** Extend the blind calibration from 6 pilot cases to all 10 goldens (10 diagnoses + 30 recs = 40 dimension judgments). Report verdict / exact / within-1 agreement per dimension.
- **Why it earns its place:** Turns "pilot shows the judge is calibrated" into "the whole eval is calibrated." Interview-defensible statement: "here's the number that says our judge agrees with humans."
- **Files to touch:** `eval/calibration/` (add blind-scoring artifacts), new `eval/calibration.eval.ts` (compares), `eval/report.eval.ts` (surfaces per-dim calibration).
- **Done when:** the report includes a per-dim calibration line; the numbers are committed as a baseline.
- **Estimated effort:** `1–2 days` including the blind human scoring.

## Interview defense

**Q: How do you know your judge isn't just agreeing with itself?**

Blind calibration. Session D pilot: 24 dimension-judgments where a human scored them blind, then the judge scored them. Verdict agreement 6/6 (100%); exact-score 13/24 (54%); within-1 24/24 (100%). At the verdict level — pass/fail — the judge matches the human. At granular per-dim scores, the noise is bounded to ±1. That's what makes the eval numbers defensible.

**Q: Isn't Sonnet judging Sonnet a problem?**

Yes — self-preference bias is real. Mitigation options: use a different judge model (introduces cross-family inconsistency across judge upgrades), or calibrate against blind human scoring (bounds the residual). I chose calibration. The 100% verdict agreement in the pilot says the residual is small enough that the pass/fail decisions are trustworthy. Load-bearing: knowing the tradeoff and picking the right side for this codebase's shape.

## See also

- [02-eval-methods.md](02-eval-methods.md) — the rubric the judge scores against.
- [04-llm-observability.md](04-llm-observability.md) — where calibration numbers show up in reports.
- [../01-llm-foundations/04-structured-outputs.md](../01-llm-foundations/04-structured-outputs.md) — the schema constraint that makes judge output well-formed.

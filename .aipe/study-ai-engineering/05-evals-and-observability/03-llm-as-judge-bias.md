# 03 — LLM-as-judge bias

**Type:** Industry standard. Also called: judge model bias, meta-eval, judge calibration.

## Zoom out, then zoom in

Three biases the LLM judge carries by default. This repo ran a Session-D pilot calibration slice to measure whether the judge could be trusted.

```
  Zoom out — three biases + this repo's mitigation

  ┌─ Position bias ─────────────────────────────────────────────────┐
  │  Judge prefers whichever variant appears first                   │
  │  fix: randomize order                                            │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ Verbosity bias ────────────────────────────────────────────────┐
  │  Judge prefers longer responses                                  │
  │  fix: cap length or score length as its own dim                  │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ Self-preference ───────────────────────────────────────────────┐
  │  Judge prefers outputs from the same model family                │
  │  fix: use a DIFFERENT family as judge                            │
  └─────────────────────────────────────────────────────────────────┘

  ★ THIS REPO measured Sonnet-judge vs Haiku-judge agreement to
    quantify the self-preference risk in Session D.
```

Zoom in. LLM-as-judge is cheap (~$0.04/judgment) but biased. The Session-D calibration pilot compared verdicts across two judges (Sonnet, Haiku) on 6 cases: **verdict agreement 6/6 (100%), exact-match dims 13/24 (54%), within-1 dims 24/24 (100%).** That's the measured trust ceiling.

## Structure pass

Axis: what makes the judge wrong?
- Position: order dependency
- Verbosity: length weighting
- Self-preference: family homophily

**Seam:** the judge's model choice. Change which model judges = change the bias profile.

## How it works

### Move 1

You've had a code review where the reviewer preferred your patch to your colleague's not because it was better but because it was longer / more detailed / from their close team. Same bias shape, at model scale.

```
  Three known judge biases (all measurable, all mitigatable)

  position:    "A" wins more often than "B" when swapped   ← measure by swap
  verbosity:   longer wins more often                       ← measure by length correlation
  self-pref:   same-family judge scores higher              ← measure by cross-family
```

### Move 2

**Position bias.**

Not applicable in this codebase's current shape — the judge scores one output at a time against a rubric, not two variants pairwise. Would matter if `02-eval-methods.md`'s Case B pairwise eval were added.

**Verbosity bias.**

Applicable. `RubricJudge` isn't length-blind. If the diagnosis conclusion is 300 words vs 100 words, the longer one may score higher on `root_cause_plausibility` because it discusses more mechanisms — even if the shorter is more precise. Mitigation: none in the rubric today. Would be Case B (add a `length_appropriateness` dim, or normalize the score against length correlation across the goldens).

**Self-preference.**

Applicable and MEASURED. The agent-under-test runs on `claude-sonnet-4-6`. The judge in `eval/run.eval.ts:229` also runs on `claude-sonnet-4-6`. Same family. Self-preference risk is real.

**The Session-D calibration slice.**

`eval/compute-agreement.eval.ts` + `eval/calibration/agreement-*.json`. Compared two judges (Sonnet at temp 0, Haiku at temp 0) on 6 golden cases (3 has-signal, 2 no-signal, 1 positive). Measured:
- **Verdict agreement**: 6/6 (100%). Both judges reached the same pass/pass_with_notes/fail verdict on every case.
- **Exact-match dims**: 13/24 (54%). Individual dim scores matched exactly ~half the time.
- **Within-1 dims**: 24/24 (100%). Every dim was within ±1 score. No wild disagreements.

Interpretation: the RUBRIC is robust across judges (verdicts stable, no wild dim disagreements), but individual scores are noisy at the 1-point level. That's the trust ceiling — this repo can rely on verdict-level regression detection, not on 0.1-point dim comparisons.

**What the calibration DIDN'T catch.**

If BOTH judges (Sonnet, Haiku) are wrong the same way — e.g. both over-score `evidence_grounding` when the diagnosis uses fancy vocabulary — that's shared bias, not measurable by cross-model agreement. A human-labeled ground truth would catch it. Not built.

### Move 3

Trust the verdict; don't trust the score. LLM-as-judge is reliable at the coarse level and noisy at the fine level. Design your eval to depend on the coarse level — pass/fail gate on verdicts, not on fractional dim scores.

## Primary diagram

```
  This repo's Session D calibration slice

  ┌─ 6 golden cases ──────────────────────────────────────────────────┐
  │  01-conversion-drop-mobile-checkout    (has-signal)                │
  │  02-fraud-payment-failure-credit-card  (has-signal)                │
  │  03-session-drop-organic-mobile        (has-signal)                │
  │  05-no-signal-retention-subscribers    (no-signal)                 │
  │  07-positive-conversion-surge-mobile   (positive)                  │
  │  09-engagement-drop-email-campaign     (partial-signal)            │
  └─────────────┬─────────────────────────────────────────────────────┘
                │
     ┌──────────┼──────────┐
     ▼                     ▼
  ┌─ Judge A ──────┐   ┌─ Judge B ──────┐
  │  Sonnet 4.6    │   │  Haiku 4.5     │
  │  temp = 0      │   │  temp = 0      │
  └────┬───────────┘   └────┬───────────┘
       │                    │
       │  verdicts          │  verdicts
       ▼                    ▼
  {pass, fail, pass_w_notes, ...}    ← compared per-case
       │
       ▼
  agreement metrics (eval/calibration/agreement-*.json):
    verdict agreement:  6/6 (100%)
    exact-match dims:  13/24 (54%)
    within-1 dims:     24/24 (100%)
```

## Elaborate

The literature on LLM-as-judge biases grew fast around 2023-2024. Notable papers: "Judging LLM-as-a-judge with MT-Bench and Chatbot Arena" (Zheng et al. 2023, established position bias and verbosity bias); "Large Language Models are not Fair Evaluators" (Wang et al. 2023, self-preference).

Standard mitigations beyond what's in this repo: **G-Eval-style chain-of-thought judging** (make the judge reason before scoring), **multi-judge ensembles** (average across 3-5 diverse judges), **rubric-anchored scoring** (this repo's approach — 1-5 scores with per-score descriptions constrain drift).

## Project exercises

### Exercise — verbosity-bias measurement

- **Exercise ID:** C3.3-A · Case A (concept exercised at the pilot level; extend to measure).
- **What to build:** across the 10-case receipts, compute per-dim correlation between diagnosis length (character count) and dim score. If any dim correlates with length at |r| > 0.4, flag as verbosity-biased. Report in `report.eval.ts`.
- **Why it earns its place:** turns "verbosity bias is real" into a measured claim on this repo's specific rubric. Interviewer signal: "I know which of my dims are length-biased, and I have the number."
- **Files to touch:** `eval/report.eval.ts` (add correlation section), receipt already has length.
- **Done when:** report prints per-dim length-correlation across the 10-case run.
- **Estimated effort:** 1-4hr.

## Interview defense

**Q: What biases does your judge carry?**

Three known ones: position (pairwise ordering matters — not applicable here since I'm rubric-scoring, not pairwise), verbosity (longer wins — applicable, unmeasured), self-preference (same family — applicable, MEASURED). The Session-D pilot ran a cross-family calibration slice: verdict agreement between Sonnet-judge and Haiku-judge was 6/6 on 6 cases. Same-family risk exists but is bounded.

**Q: How can you trust the judge?**

At the verdict level. Cross-family agreement was 100% on verdicts, 100% within-1 on dim scores. That means my regression gate on verdicts is safe. My gate on fractional dim differences would be noisy — I don't rely on that.

```
  Trust ceiling from Session D:
  · verdict-level:   100% agreement → use for gating
  · dim exact-match: 54%             → don't rely on 0.1 differences
  · dim within-1:    100%            → dim regressions of 2+ are real
```

**Q: What if both judges are wrong the same way?**

That's shared bias — not detectable by cross-model agreement. Only human-labeled ground truth catches it. Not built. If I saw suspicious eval results (e.g. all diagnoses passing but the recommendations obviously wrong on inspection), I'd add a small human-labeled set as a sanity check.

## See also

- `02-eval-methods.md` — the rubric that biases apply to
- `04-llm-observability.md` — the receipt structure calibration lives in
- `eval/calibration/agreement-*.json` — the actual pilot results
- `eval/compute-agreement.eval.ts` — the agreement math

# Exercise 04 — the rubric: AI drafts, human decides

## ① verdict

"Good" is undefined until you name *which* good. Your two rubrics
(`diagnosis-quality.ts`, `recommendation-quality.ts`) name 4 dimensions
each on a 1–5 scale with 3 verdicts. Claude drafted them. Every
threshold was a decision *you* had to sign — because a rubric with
un-signed thresholds is just prose. The exercise is to read one rubric
line by line and confirm you actually stand behind every threshold, and
if you don't, edit it.

## ② analogy

An essay rubric. AI can suggest "clarity, evidence, structure" — that's
the dimensions menu. The teacher decides what earns a 5 on each. The
teacher's signature on the thresholds is what turns a rubric from
decoration into a grading instrument.

## ③ in your repo

Two rubric files:

- `eval/rubrics/diagnosis-quality.ts` — 4 dims × 1–5 · 3 verdicts
- `eval/rubrics/recommendation-quality.ts` — 4 dims × 1–5 · 3 verdicts

The engine that consumes them (`RubricJudge`, `RubricDefinition`) lives
in `@aptkit/evals`; the domain data — dimension names, threshold prose,
verdicts — lives in these two files.

## ④ human track — the dimensions and thresholds

The dimensions menu is universal. What you picked from it is a domain
call. Your recommendation rubric picked:

```
  the recommendation-quality dimensions — why THESE four

  diagnosis_response  ─ addresses the diagnosed cause, not a
                         different problem
                         → catches: rec agent silently pivoting to a
                           more familiar problem shape
                         → baseline pass rate: 48%  ← the Move-3 bruise

  feature_choice_fit  ─ the right Bloomreach lever for the problem
                         (scenario / segment / campaign / voucher /
                          experiment)
                         → catches: "wrong shape of solution" —
                           a segment where a scenario is needed
                         → baseline pass rate: 62%

  step_actionability  ─ steps are executable, not aspirational
                         → catches: "consider setting up X"
                           instead of "do Y with Z on entities W"
                         → baseline pass rate: 100%  ← the rubric
                           says the recs already do this well; useful
                           dim, but not where the failures are

  impact_realism      ─ estimatedImpact is proportional AND grounded
                         in the diagnosis numbers
                         → catches: $500K impact on a $42K anomaly;
                           magnitude right but no `assumption`
                         → baseline pass rate: 43%
```

Now read the threshold prose. Take `diagnosis_response`, score 5:

> *"Directly targets the diagnosed cause AND anticipates second-order effects or downstream risks named in the diagnosis."*

That's a decision. Someone chose "anticipates second-order effects" as
the difference between a 4 and a 5. If it were the coach's rubric it
might have said "AND names one alternative explanation the rec would NOT
address." Different threshold, different bar. Neither is wrong — but
whichever you ship is the one you have to stand behind at interview.

The failure mode this rubric explicitly guards against (from the top of
the file, `recommendation-quality.ts:11–16`) — read this too:

```
  · disconnected      ─ rec doesn't respond to the diagnosis's cause
  · wrong lever       ─ chosen bloomreachFeature doesn't fit
  · vague             ─ steps say "consider" instead of "do"
  · impact fantasy    ─ estimatedImpact isn't proportional
```

That failure-modes list is where the four dimensions came from. You
started from "what would a bad rec look like?" and worked back to "which
dimensions catch each mode." That's the human authoring — and it's the
step Claude cannot do for you, because it requires knowing what YOUR
domain's failure modes look like.

## ⑤ AI track — where Claude helped

- **Dimension names**: Claude's default menu is `faithfulness`, `relevance`, `completeness`, `safety`, `format/style`, `task-specific`. You either kept those or renamed. Your four (`diagnosis_response`, `feature_choice_fit`, `step_actionability`, `impact_realism`) are all `task-specific` in Claude's menu — a domain call.
- **Threshold prose**: Claude drafted "vague evidence references; no specific numbers cited" for score 2 on `evidence_grounding`. You read it and either kept it or sharpened it.
- **Verdict boundaries**: "pass = all dims ≥4" is a conventional draft. You could have made it "pass = all dims ≥4 AND at least one dim = 5" for a stricter bar. That's a knob you own.

Verification is *reading the rubric with a real diagnosis in front of
you*. Pick a diagnosis from `eval/receipts/`, read each dimension's
1–5 prose, and ask: *would I have scored it the same way as the judge
did?* If yes, the rubric holds. If no, either the rubric or your
mental model is off — the calibration exercise (05) is what tells you
which.

## ⑥ do it

1. Open `eval/rubrics/recommendation-quality.ts`. Read the top comment
   block (lines 8–17) — those four failure modes are the human-authored
   spine.
2. For each of the 4 dimensions, read all 5 scale entries. Ask: *if I
   swapped the 4 and the 5 prose — could I defend the swap?* If yes, the
   bar between them is fuzzy and you should sharpen. (Coach's read on
   `diagnosis_response`: 4 says "directly targets," 5 says "AND
   anticipates second-order effects." That's a clean bar — 5 is 4 plus
   one specific thing. Good.)
3. Pull up one real rec from a receipt in `eval/receipts/` (any recent
   run). Score it yourself against `impact_realism` before looking at
   the judge's score. Then read the judge's score in the receipt. If you
   agree: the rubric works for you on this dim. If you disagree by ≥2
   points: the rubric or the judge is off (Exercise 05 is where you
   measure this systematically).
4. On the recommendation rubric, add a dimension — even hypothetically.
   The most-often-suggested addition: `mechanism_specificity` (does the
   rec name the specific Bloomreach mechanism to change, not just the
   feature category?). Decide: does it earn a slot, or does it fold
   into `step_actionability`? That decision is you owning the rubric.
5. Compare `diagnosis-quality.ts` vs `recommendation-quality.ts` side by
   side. Note that the diagnosis rubric's `evidence_grounding` gets the
   heaviest treatment (the "cites at least one number" check in
   `checks[]`). That's because confabulation is the top failure mode
   for the diagnostic agent — and the rubric is shaped to catch it.
   Domain call. Yours.

## ⑦ done when

- You can name the four failure modes each rubric guards against, in
  the domain (not the generic "faithfulness / relevance" menu).
- You've read every threshold in one dimension and either signed off on
  it or edited it. The rubric is yours after this.
- You can name at least one threshold you'd sharpen — even if you don't
  ship the edit today.
- You can answer *"why these four dimensions and not the other three
  from Claude's menu?"* in terms of your app's failure modes: because
  the diagnostic agent confabulates, `evidence_grounding` earns the
  heaviest treatment; because the rec agent silently pivots to a
  familiar problem shape, `diagnosis_response` gets its own dim.

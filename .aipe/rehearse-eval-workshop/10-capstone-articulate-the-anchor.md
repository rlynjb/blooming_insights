# Exercise 10 — capstone: articulate the anchor

## ① verdict

Say the answer out loud. Grounded in files you've read and receipts
you've produced across the workshop. The interviewer's question is:

> **"You let AI write the app AND the eval — why do you trust the result?"**

The answer is not "because I typed it." The answer is the anchor: a
small set of cases a human labeled, and a measured agreement rate
between the judge and those labels, plus a lived receipt of the eval
catching a real regression. That's what trust looks like when the same
kind of intelligence writes both the code and the test.

## ② analogy

The building inspector's signature isn't trusted because the inspector
built the house. It's trusted because the inspector's standards agree
with the building code (calibration), and there's a track record of
their signatures matching what a re-inspection would find (receipts).
Same shape, same trust.

## ③ in your repo — what to point at when you answer

You have three artifacts. All on disk. Every one is real.

```
  the three artifacts your answer points at

  1. THE ANCHOR (Exercise 05)
     eval/calibration/worksheet-2026-07-03T02-47-24-392Z.json
     eval/calibration/agreement-2026-07-03T02-47-24-392Z.json
     → pilot ran AI-vs-AI: verdict 6/6, exact 13/24, within-1 24/24
     → real human pass is the growth target (n≥30)

  2. THE LIVED RECEIPT (Exercise 08, Exercise 09)
     .aipe/drills/agents-and-tool-use-induce-multi-agent-coordination-failure.md
     eval/gate-2026-07-03T18-11-06-952Z.json (the gate output that fired)
     → commit be05240 shipped filterSupportedHypotheses at the handoff
     → eval regressed all 4 rec dims by 13-23pp case-matched
     → reverted; tombstone at lib/agents/recommendation.ts:31-41
     → the eval was doing exactly what the eval is for

  3. THE BASELINE (Exercise 09)
     eval/baseline.json (runId 2026-07-03T04-08-28-644Z)
     → 10 goldens · 4 rubric dims × 2 rubrics · pass rates committed
     → gate blocks any dim regressing > 10pp
     → CI at .github/workflows/ci.yml
```

## ④ human track — what to actually say

The interview answer, in your words, past-tense, grounded, short:

> *"AI wrote my harness, drafted my rubrics, and generated candidate
> case inputs. It did NOT write my ground-truth labels or my calibration
> verdicts. I trust the eval because it agrees with the labels I wrote
> at a measured rate — verdict 6/6 in the AI-vs-AI pilot, growing to
> n≥30 with a real human pass next. And I have the receipt that the eval
> catches real regressions: I shipped a fix at a multi-agent handoff,
> the eval flagged a 13–23pp regression across four dimensions, I
> reverted with a tombstone. The eval caught my wrong mental model
> before it shipped. That's why I trust it — not because I typed it."*

Read that sentence out loud. Then say it in front of a mirror. Then
say it in front of another engineer. It should feel *natural* — not
recited. If it feels recited, break it apart:

- Sentence 1: **who wrote what** (harness / rubrics / cases split from Ex 01).
- Sentence 2: **the anchor** (calibration + the receipt from Ex 05).
- Sentence 3: **the lived proof** (Move 3, from Ex 08 and Ex 09).
- Closing: **the principle** — trust is a measured number, not authorship.

## ⑤ AI track — what Claude produced across the workshop

For every artifact in ③, name what Claude did and how it was verified:

- **`run.eval.ts`** — Claude wrote 470 LOC. Verified by the receipt files on disk and the contract inspection in Ex 03.
- **`gate.eval.ts`** — Claude wrote the delta math. Verified by the Move 3 gate output that fired on a real regression.
- **The two rubric drafts** — Claude drafted dimensions and threshold prose. Verified by you reading each threshold with a real diagnosis in front of you (Ex 04) and by the calibration agreement number (Ex 05).
- **Candidate case inputs** — Claude drafted (where used); the `knownCorrect` labels are yours.
- **The compute-agreement math** — Claude wrote `compute-agreement.eval.ts`. Verified by hand-checking one row of the agreement receipt.

Notice what Claude never touched: **the labels** — `knownCorrect` in
each golden, `yourScores` in each worksheet entry. Those are the
anchor. That's the answer to the interview question.

## ⑥ do it

1. Print (or open in a second monitor) the three artifacts from ③.
2. Read the interview answer in ④ out loud once.
3. Rehearse variations for the interviewer's follow-ups:
   - **"Why 6/6 and not 10/10?"** — because the pilot ran on 6 verdicts
     of 6 cases where the AI-vs-AI verdict matched. The 24 dimension-
     scores split into 13 exact + 11 within-1 gives you the granularity
     picture. And I'll be honest — the pilot is AI-vs-AI. The real
     receipt comes from a human pass. That's the growth target.
   - **"Show me the receipt."** — open `.aipe/drills/agents-and-tool-use-induce-multi-agent-coordination-failure.md`,
     scroll to the Step 4 shipped-then-reverted block, point at the
     case-matched delta table.
   - **"How do you know the judge isn't just agreeing with the
     baseline?"** — because the calibration protocol strips the
     judge's scores from the worksheet before the human fills it in
     (`eval/generate-worksheet.eval.ts`). Blind is load-bearing.
   - **"What's your biggest gap?"** — the real-human calibration pass
     at n≥30. Pilot ran AI-vs-AI. I know that's a smoke test and I
     know what closes it.
4. Write the answer in your own words. Do not copy the sentence above
   verbatim. The point of the workshop is that you can build it from
   the artifacts.

## ⑦ done when

- You can say the answer in your own words, without notes, in under 60 seconds.
- You can point at each of the three artifacts in ③ from memory (file paths).
- You can name what Claude wrote for you AND what verified it, for every artifact — not "because I typed it," always "because the measured number / the smoke test / the gate firing / the receipt confirms it."
- You have an honest capstone if the numbers are still thin: *"the machine is real. The anchor is a smoke test. Next I grow the labels."* That's a defensible answer, and it's better than overclaiming a pilot as a receipt.

## the principle that generalises

Same-kind intelligence writing both the app and the test is fine —
*if* there's a human-owned anchor below the test that neither the app
nor the test author touches. The anchor doesn't scale (labeling is
slow). But it doesn't have to — it just has to *calibrate* the test,
so the test can scale beyond what the human labeled.

That's the whole model. Trust is a measured agreement rate between a
scaled test and a small human-owned anchor. Not authorship. Not
"AI wouldn't lie to me." Measurement.

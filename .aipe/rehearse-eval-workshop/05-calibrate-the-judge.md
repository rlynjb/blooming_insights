# Exercise 05 — the trust anchor: calibrate the judge  ← THE SPINE

## ① verdict

This is the answer to *"AI wrote your app AND your eval — why do you
trust the result?"* Hand-label a handful of cases blind. Run the judge
on the same cases. Measure agreement. If the numbers agree, the judge
has earned its role as your gate. **Trust is a measured number, not an
authorship claim.**

You have a pilot: `eval/calibration/worksheet-2026-07-03T02-47-24-392Z.json`
was filled in AI-vs-AI (verdict 6/6, exact-match 13/24, within-1
24/24). That's a smoke test at n=6. The real receipt is a HUMAN pass at
n≥30. This exercise is that real pass.

> **If you only do one exercise in this workshop, do this one.** It
> converts "AI wrote my eval, is it real?" from a claim into a measured
> number. Every other exercise props this one up.

## ② analogy

Checking a new thermometer against one you know is accurate before you
rely on its readings. You don't accept a thermometer because it *looks*
professional. You test it against a known-accurate reading and check
they agree. The rubric judge is a thermometer for diagnosis quality.
The human labels are the known-accurate reading. Agreement is the
calibration curve.

## ③ in your repo

Three files at `eval/calibration/` are already on disk:

```
  eval/calibration/README.md                   ← the protocol
  eval/calibration/worksheet-2026-07-03T02-47-24-392Z.json
                                                ← blank template + AI pilot
  eval/calibration/agreement-2026-07-03T02-47-24-392Z.json
                                                ← receipt (pilot: AI-vs-AI)
  eval/generate-worksheet.eval.ts              ← scaffolds a fresh worksheet
  eval/compute-agreement.eval.ts               ← computes agreement math
```

The protocol at `eval/calibration/README.md`:

```
  1. Run the goldens                   npm run eval
                                        → per-case receipts land in
                                          eval/receipts/ (gitignored)

  2. Generate the blank worksheet      npm run eval:worksheet
                                        → eval/calibration/
                                          worksheet-<runId>.json
                                          (anomaly + diagnosis + rubric;
                                           judgment fields BLANK)

  3. Fill in yourScores + yourVerdict  in-place edit of the worksheet
     per case                           ← THIS IS THE HUMAN STEP
                                        ~30–60 min for 10 cases

  4. Compute agreement                 npm run eval:agreement
                                        → agreement-<runId>.json
                                          + printable summary
```

**Blind is load-bearing.** The worksheet you fill in has the anomaly,
the diagnosis, and the rubric — but NOT the judge's scores. If you saw
the judge's scores before filling in yours, you'd anchor to them. That
measures self-agreement, not calibration.

## ④ human track — hand-scoring the calibration set

You author `yourScores` and `yourVerdict` in the worksheet. That's the
anchor. Everything AI does downstream is graded against it.

The mechanics of the labeling:

- Open one worksheet entry (one golden case). Read the anomaly. Read the diagnosis. Read the rubric.
- For each of the 4 dimensions, decide your score (1–5) using the rubric's threshold prose. Write it in `yourScores.<dim>`.
- Assign an overall `yourVerdict` (`pass` / `pass_with_notes` / `fail`) using the rubric's verdict definitions.
- Do NOT peek at the judge's scores. The worksheet generator (`generate-worksheet.eval.ts`) strips them out for exactly this reason.

**Include some BAD cases**. If every case in your calibration set is a
strong diagnosis, the judge only needs to be right on strong cases.
Real calibration spreads across the range — write in some deliberately
weak or wrong diagnoses so the judge's ability to *distinguish* good
from bad gets measured, not just its ability to say "yes this is good."

The pilot used the 10 shipped goldens. That's a start (n=10 unified /
40 dim-scores). Real receipt: **n≥30 cases** — the extra 20 come from
you writing bad-diagnosis variants and adding them as calibration-only
entries (not new goldens).

## ⑤ AI track — running the judge and computing agreement

Everything downstream of the human labels is Claude's.

- **The judge**: Claude ran `RubricJudge` on the same case set. Its scores are in the receipt files at `eval/receipts/`.
- **The agreement math**: `eval/compute-agreement.eval.ts` reads the worksheet + receipts and produces three numbers.
- **The agreement types**:

```
  verdict agreement       N/M    exact match on {pass, pass_with_notes, fail}
                                  e.g. 7/10  — 7 of 10 cases the judge
                                              and human called the same
                                              overall verdict

  exact-match dimensions  N/M    exact match on the 1–5 score, per dim
                                  e.g. 28/40 — of 40 dimension-scores,
                                              28 hit the same integer

  within-1 dimensions     N/M    off by no more than 1 point per dim
                                  e.g. 36/40 — of 40 dimension-scores,
                                              36 were within ±1

  per-dimension breakdown        which dims we agree on most / least
  per-case table                 user vs judge score per dim with delta
```

**The pilot receipt** (AI-vs-AI, at `agreement-2026-07-03T02-47-24-392Z.json`):
verdict 6/6, exact 13/24, within-1 24/24. It's a smoke test — real
signal because the AI-vs-AI verdict agreement is unanimous — but n=6
verdicts is not enough to defend at interview. The interview answer
needs n≥30 real-human labels.

Verification: after the agreement script runs, read the per-case table.
Where you and the judge disagreed by ≥2 points, look at both scores +
the diagnosis + the rubric threshold. One of three things is true:

- **Your score is wrong** — reread the threshold; you drifted. (Rare if you calibrated on the rubric before starting.)
- **The judge's score is wrong** — the rubric threshold is fuzzy at that boundary, or the judge's prompt needs work. (Route to Exercise 04 — sharpen the rubric.)
- **The disagreement is legitimate** — the case is genuinely ambiguous. Log it; some ambiguity is fine; systematic ambiguity is a rubric problem.

## ⑥ do it

The full loop is the exercise. It takes ~30–60 min for 10 cases, plus
another 30–45 min if you extend to 30 cases with bad-diagnosis
variants.

1. **Regenerate a fresh worksheet against your latest baseline** (Move 3
   ran `2026-07-03T04-08-28-644Z`; you may want a newer run first):

   ```bash
   npm run eval           # produce fresh receipts
   npm run eval:worksheet # scaffold worksheet-<newRunId>.json
   ```

2. **Fill in `yourScores` + `yourVerdict` for each case, blind.** No
   peeking at the judge scores in `eval/receipts/`. Reference only the
   rubric (`eval/rubrics/diagnosis-quality.ts`) and the case
   (anomaly + diagnosis in the worksheet entry).

3. **Extend the set with 5–10 deliberately bad diagnoses.** Take one of
   your goldens, hand-write a diagnosis that would score a 2 on
   `evidence_grounding` (invents numbers) or a 2 on `scope_coherence`
   (drifts out of the anomaly's scope). These are calibration-only
   entries. Adding failure spread to the calibration set is where a
   pilot becomes a receipt.

4. **Compute agreement**:

   ```bash
   npm run eval:agreement
   ```

   Read the summary. The three top-level numbers are your receipt.

5. **If verdict agreement < 80% OR within-1 agreement < 90%**: route
   back to Exercise 04. The rubric or the judge prompt needs work. This
   is not a "the eval is broken" moment — it IS the work. Iterating
   rubric → recalibrating → measuring is the calibration loop.

6. **Commit the resulting `worksheet-*.json` + `agreement-*.json`**. Both
   are safe to commit (per `eval/calibration/README.md`) and are the
   evidentiary artifact.

## ⑦ done when

- You can state the judge's agreement rate AND its `n`, and you know
  which is a smoke test (n≈6 verdicts, current pilot) and which is
  trustworthy (n≥30).
- You've hand-labeled at least 10 cases blind. Preferably 30 with bad-
  diagnosis spread.
- You've computed `agreement-<runId>.json` and can point at it.
- You can say the interview sentence: *"I hand-labeled n=[X] cases blind
  and the judge agrees on verdict [N]/[X], within-1 on dimensions
  [N]/[X×4]. That's why I trust the eval — not because I typed it, but
  because it agrees with my labels at a measured rate."*
- If verdict agreement is < 80%, you know that IS the work — iterate
  rubric or judge prompt and re-run. The loop is the discipline.

## the honest capstone (if you can't finish the full pass today)

*"AI wrote the harness, drafted my rubric, and generated candidate
inputs. It did NOT write my calibration verdicts. The pilot ran
AI-vs-AI at verdict 6/6, exact 13/24, within-1 24/24 — the machine is
real. The anchor is still a smoke test; next I grow the labels to n≥30
with a real human pass."*

That is a defensible interview answer even before the real-human pass.
It names the receipt you have and the receipt you're growing to. It
does not overclaim.

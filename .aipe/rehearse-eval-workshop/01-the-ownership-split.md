# Exercise 01 — the ownership split

## ① verdict

An eval has three parts and only ONE is human-owned. Sort every file in
your `eval/` directory into the three buckets, and the mental model is
yours forever. You already have all three parts in the repo; the exercise
is to *see* which is which.

## ② analogy

Building a house. Claude can pour the foundation and frame the walls
(harness), and *draft* the building inspector's checklist (rubric). But
the inspector's signature that this house is safe (the labels) is a human
standing behind a judgment. You don't outsource the signature.

## ③ in your repo

Every file below is on disk right now:

```
  the eval/ tree, sorted by ownership (the exercise fills this in)

  harness (Claude drafts, you sign the contract)
  ─────────────────────────────────────────────
    eval/run.eval.ts                       ← the main loop
    eval/gate.eval.ts                      ← regression gate
    eval/baseline.eval.ts                  ← computes baseline from receipts
    eval/report.eval.ts                    ← per-run summary
    eval/load.eval.ts                      ← concurrency harness
    eval/probe-h1-isolation.eval.ts        ← Move 3's isolation probe
    eval/compute-agreement.eval.ts         ← calibration math
    eval/generate-worksheet.eval.ts        ← scaffolds a blank worksheet

  rubrics (Claude drafts criteria, you edit thresholds)
  ─────────────────────────────────────────────────────
    eval/rubrics/diagnosis-quality.ts      ← 4 dims × 1–5
    eval/rubrics/recommendation-quality.ts ← 4 dims × 1–5

  cases + LABELS (human authors, no exceptions)
  ─────────────────────────────────────────────
    eval/goldens/01-*.ts … 10-*.ts         ← anomaly + knownCorrect per case
    eval/goldens/types.ts                  ← the shape

  calibration anchor (human labels, no exceptions)
  ────────────────────────────────────────────────
    eval/calibration/worksheet-2026-07-03T02-47-24-392Z.json
      ← human fills `yourScores` + `yourVerdict` blind
    eval/calibration/agreement-2026-07-03T02-47-24-392Z.json
      ← computed receipt (judge vs human)

  receipts (Claude produces, gitignored, evidentiary)
  ───────────────────────────────────────────────────
    eval/receipts/*.json                   ← 40+ files, one per case per run
    eval/baseline.json                     ← committed reference (Ex 09)
```

## ④ human track — what only you can author

For each file, apply the test that names the owner:

> **"If AI wrote this and got it subtly wrong, what catches the mistake?"**

- **Plumbing errors** (harness bugs) — caught by tests and by the smoke run passing/failing loudly.
- **Rubric errors** (wrong threshold on `impact_realism`) — caught by *you* reading the rubric with a real recommendation in front of you.
- **Label errors** (wrong `knownCorrect` on a golden, or a wrong `yourScores` in the worksheet) — caught by **nothing**. There is no second signal below the label. Which is why humans own labels.

That last row is the whole point. When there's no signal below a layer to
catch its mistake, that layer must be human-authored.

## ⑤ AI track — what Claude may draft and how it's verified

- **Harness**: Claude drafted `run.eval.ts` end to end (470 LOC). You verify by reading its contract (Ex 03) and by the smoke run producing readable receipts on disk.
- **Rubric criteria**: Claude drafted `diagnosis-quality.ts`. You verify by reading each threshold with a real diagnosis in front of you (Ex 04) and editing what doesn't hold up.
- **Candidate case inputs**: Claude may draft anomalies for new goldens ("give me 5 realistic fraud anomalies"). You dispose the labels — `knownCorrect` is yours.
- **Candidate rubric dimensions**: Claude may suggest "add a `disambiguation_quality` dim." You decide whether it earns a slot.

Never AI-authored: `knownCorrect` in goldens, `yourScores` / `yourVerdict`
in the calibration worksheet, and the ship/no-ship threshold in the gate
(that's a business call).

## ⑥ do it

1. Open your `eval/` directory and read the tree above alongside `ls eval/`.
2. For each file, name the bucket out loud (harness / rubric / case-and-labels / calibration-anchor / receipt).
3. For each of the three ownership rows, name the failure mode of each: *what would a subtle AI-authored mistake look like, and what would catch it?*
4. Pick the one file in the tree that is **most load-bearing** — the one you'd protect first if you could only pick one to lock down.

Hint before you answer step 4: the anchor is the calibration worksheet.
Everything else can regenerate; the human labels can't.

## ⑦ done when

- You can name every file in `eval/` as harness / rubric / case-labels / calibration-anchor / receipt without hesitating.
- You can name the *one* thing Claude must never author: the human labels — either `knownCorrect` in the goldens or `yourScores` in the calibration worksheet.
- You can answer "why do humans own labels?" with the specific reason: *there is no signal below the label layer to catch its mistake — plumbing errors have tests, label errors have nothing.*

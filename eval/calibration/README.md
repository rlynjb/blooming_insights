# eval/calibration — blind judge-vs-human calibration

This folder holds the calibration slice for the diagnosis-quality rubric.
Its purpose is to answer one question with a defensible receipt:

> **Does the judge's scoring match what a human reviewer would say?**

If yes (high agreement): the judge earns its role as the eval gate.
If no (low agreement): the rubric or the judge prompt needs work before
the eval can gate anything.

The retired Phase 3 pipeline established **8/8 + 3/3 manual agreement**
against Olist. Session D is the rebuild target against Synthetic.

## Protocol

The protocol is **blind labeling**. The human never sees the judge's
scores before assigning their own. Anything else measures self-agreement,
not calibration.

```
1. Run the goldens                    npm run eval
                                       → 10 per-case receipts land in
                                         eval/receipts/ (gitignored)

2. Generate the blank worksheet       npm run eval:worksheet
                                       → eval/calibration/
                                         worksheet-<runId>.json
                                         (anomaly + diagnosis + rubric;
                                         no judgment visible)

3. Fill in yourScores + yourVerdict   in-place edit of the worksheet
   per case                            ~30–60 min for 10 cases

4. Compute agreement                  npm run eval:agreement
                                       → eval/calibration/
                                         agreement-<runId>.json
                                         + printable summary
```

## What survives interview scrutiny

The `agreement-<runId>.json` file has three top-level numbers:

```
Verdict agreement       N/M   e.g. 7/10
Exact-match dimensions  N/M   e.g. 28/40
Within-1 dimensions     N/M   e.g. 36/40
```

Plus a per-dimension breakdown (which dimensions we agree on most /
least — a calibration insight) and a per-case table (user | judge score
per dimension with delta).

The number that carries the interview is the whole picture, not one
metric: *"blind-labeled N cases, verdict agreement N/M, dimension-level
agreement within ±1 M/N."*

## What's in this folder

```
README.md                          this file
worksheet-<runId>.json             one per calibration cycle (user fills in)
agreement-<runId>.json             one per calibration cycle (script writes)
```

Both worksheet and agreement files are safe to commit — they are the
calibration proof and do not require the raw receipts to be
interpretable.

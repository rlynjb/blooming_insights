# `eval/` — agent evaluation suite

> Phase 3 of the portfolio-hardening plan. Runs the production agents against
> the seeded Olist dataset, scores their outputs, writes numbers to disk.

This is **NOT** the 269-test unit suite. The unit tests mock Anthropic +
DataSource and assert wiring; this suite spends real money to measure the
real agents end-to-end.

## What lives here

```
eval/
  scripts/
    run-detection.ts                Step 1: MonitoringAgent precision/recall
                                    against the 3 seeded anomalies
    lib/
      run-agent.ts                  spawn OlistDataSource + run agent directly
      scorer.ts                     LOOSE + STRICT match logic
      summary.ts                    K-run aggregator + summary.md renderer
  fixtures/                         placeholder — PR E will populate this
                                    (reference diagnoses + judge anchors)
  results/<YYYY-MM-DD>/             one dir per eval day, committed:
    detection-K10-loose.json        full per-run matches under LOOSE
    detection-K10-strict.json       full per-run matches under STRICT
    detection-K10-raw.json          raw insights from each run (audit trail)
    summary.md                      human-readable scorecard
```

## Pre-flight (one-time)

```bash
# 1. Anthropic key in .env.local
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env.local

# 2. mcp-server-olist seeded + built
cd mcp-server-olist
npm run seed       # writes data/olist.db (~10k synthetic Olist orders +
                   # 3 seeded anomalies in the `seeded_anomalies` table)
npm run build      # writes dist/src/index.js (OlistDataSource spawns this)
cd ..
```

## Run detection (PR D — Step 1)

```bash
# K=10 — the recruiter number. ~$1-3, ~5-10 minutes.
npm run eval:detection -- --K=10

# K=2 dry-run — pipeline smoke test. ~$0.20, ~1 minute.
npm run eval:detection -- --K=2
```

The driver spawns ONE fresh `mcp-server-olist` subprocess per run so a crash
in run i doesn't poison run i+1. Errors are caught, recorded as
`runs[i].error`, and the K-run series continues — `summary.md` discloses the
errored count honestly.

## Output shape

`summary.md` is the human-readable scorecard. Two numbers matter:

- **LOOSE** (2-of-3 criteria: metric + segment + time-window). Optimistic
  ceiling. Reads "did the agent surface something semantically near this
  seeded anomaly?"
- **STRICT** (3-of-3). The recruiter number. Reads "did the agent surface
  THIS anomaly with the right metric, the right segment, AND a time signal?"

Per-anomaly detection rates surface which of the 3 seeded anomalies is
hardest to catch. The matcher heuristics are documented in
`scripts/lib/scorer.ts` — every rule is one constant or one regex with a
comment explaining its bias.

## Cost + runtime notes

- Sonnet 4.6, ~6 tool-calls per scan, max 4096 output tokens. Each run
  costs ~$0.10–0.30 depending on how chatty the agent gets in tool calls.
- K=10 is the validated pipeline; K=30 tightens the confidence interval
  to roughly ±10% on precision/recall and is reasonable for a polished
  portfolio number.
- Runs are sequential. There's no parallel mode — the Olist subprocess is
  per-instance lightweight but spinning up 10 in parallel would hit the
  Anthropic rate limit before saving meaningful time.

## What this scaffold does NOT do (yet)

- Diagnosis rubric (PR E). LLM-as-judge over the diagnostic agent's output.
- Recommendation rubric (PR F). Same shape, lighter rubric.
- Regression eval (PR G). Golden-set structural + semantic diff for
  prompt/model changes.

Each ships as a separate `npm run eval:*` script + a new fixtures section.
